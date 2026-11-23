import { redis } from "@/lib/redis";

/**
 * admit: one round trip, all-or-nothing.
 *   1. refuse if today's global spend is past the hard cap
 *   2. drop stream slots older than the TTL, refuse if the user is at max
 *   3. refuse if used + reservation would exceed the daily token budget
 *   4. otherwise reserve the tokens and take a slot
 * A refusal changes nothing, so there is nothing to roll back.
 *
 * KEYS: slots zset, token budget counter, global spend counter
 * ARGV: now ms, slot TTL ms, max slots, lease id, reserve tokens,
 *       daily token limit, budget key TTL s, soft cap micros, hard cap micros
 * Returns: { code, tokensLeft, spendMicros, degraded }
 *   code 0 = admitted, 1 = too many streams, 2 = over budget, 3 = spend cap
 */
const ADMIT = `
local now      = tonumber(ARGV[1])
local slotTtl  = tonumber(ARGV[2])
local maxSlots = tonumber(ARGV[3])
local leaseId  = ARGV[4]
local reserve  = tonumber(ARGV[5])
local limit    = tonumber(ARGV[6])
local budgetTtl = tonumber(ARGV[7])
local softCap  = tonumber(ARGV[8])
local hardCap  = tonumber(ARGV[9])

local spend = tonumber(redis.call('GET', KEYS[3]) or '0')
local used  = tonumber(redis.call('GET', KEYS[2]) or '0')
if spend >= hardCap then
  return {3, limit - used, spend, 0}
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - slotTtl)
if redis.call('ZCARD', KEYS[1]) >= maxSlots then
  return {1, limit - used, spend, 0}
end

if used + reserve > limit then
  return {2, limit - used, spend, 0}
end

local total = redis.call('INCRBY', KEYS[2], reserve)
if total == reserve then
  redis.call('EXPIRE', KEYS[2], budgetTtl)
end
redis.call('ZADD', KEYS[1], now, leaseId)
redis.call('PEXPIRE', KEYS[1], slotTtl)

local degraded = 0
if spend >= softCap then degraded = 1 end
return {0, limit - total, spend, degraded}
`;

/**
 * settle: release the slot, correct the reservation to the real token count,
 * and add the request's cost to today's global spend.
 *
 * KEYS: slots zset, token budget counter, global spend counter
 * ARGV: lease id, token delta (actual - reserved, may be negative),
 *       cost micros, spend key TTL s
 * Returns: { tokensUsed, spendMicros }
 */
const SETTLE = `
redis.call('ZREM', KEYS[1], ARGV[1])

local delta = tonumber(ARGV[2])
local used = tonumber(redis.call('GET', KEYS[2]) or '0')
if delta ~= 0 then
  used = redis.call('INCRBY', KEYS[2], delta)
  if used < 0 then
    redis.call('SET', KEYS[2], 0, 'KEEPTTL')
    used = 0
  end
end

local cost = tonumber(ARGV[3])
local spend = tonumber(redis.call('GET', KEYS[3]) or '0')
if cost > 0 then
  spend = redis.call('INCRBY', KEYS[3], cost)
  if spend == cost then
    redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
  end
end
return {used, spend}
`;

// createScript sends EVALSHA and falls back to EVAL the first time the
// script is not cached on the server, so the Lua body is not resent per call.
export const admitScript = redis.createScript<[number, number, number, number]>(ADMIT);
export const settleScript = redis.createScript<[number, number]>(SETTLE);
