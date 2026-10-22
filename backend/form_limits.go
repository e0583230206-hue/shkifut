package main

import (
	"time"

	"channel/formlimits"
)

// Limits of the report form (any logged-in Google account) and the contact form (anyone). Rules in package formlimits.
const (
	reportReasonMin = 3
	reportReasonMax = 500
	reportBodyMax   = 8 << 10

	contactMessageMax = 2000
	contactBodyMax    = 16 << 10
)

var (
	// A report: per account, per message once a day; per account a few per 10 minutes and per day; per address; and a cap for the whole site.
	reportUserRules = []formlimits.Rule{{Name: "10m", Limit: 3, Window: 10 * time.Minute}, {Name: "day", Limit: 10, Window: 24 * time.Hour}}
	reportIPRules   = []formlimits.Rule{{Name: "day", Limit: 30, Window: 24 * time.Hour}}
	reportAllRules  = []formlimits.Rule{{Name: "hour", Limit: 300, Window: time.Hour}}

	// Contact form: every try (even an invalid one) is counted loosely, a delivered message strictly; plus a cap for the whole site.
	contactTryRules  = []formlimits.Rule{{Name: "10m", Limit: 30, Window: 10 * time.Minute}}
	contactSendRules = []formlimits.Rule{{Name: "10m", Limit: 3, Window: 10 * time.Minute}, {Name: "hour", Limit: 5, Window: time.Hour}, {Name: "day", Limit: 15, Window: 24 * time.Hour}}
	contactAllRules  = []formlimits.Rule{{Name: "hour", Limit: 100, Window: time.Hour}}

	formLimiter = formlimits.Limiter{Counter: redisCounter{}}
)

// redisCounter: INCR, and a window that ends by itself (EXPIRE on the first event, and again if a key somehow has no expiry).
type redisCounter struct{}

func (redisCounter) Incr(key string, window time.Duration) (int64, error) {
	ctx, cancel := redisCtx()
	defer cancel()
	n, err := rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, err
	}
	if n == 1 {
		rdb.Expire(ctx, key, window)
	} else if ttl, err := rdb.TTL(ctx, key).Result(); err == nil && ttl == -1 {
		rdb.Expire(ctx, key, window)
	}
	return n, nil
}
