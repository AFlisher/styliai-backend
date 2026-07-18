-- Adds country fields to public.users, populated at registration time
-- from a local IP geolocation lookup (see src/utils/geoIp.js). No IP
-- address is stored; only the resolved country code/name are kept.
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(2),
    ADD COLUMN IF NOT EXISTS country_name VARCHAR(100);

-- Speeds up the Users by Country aggregation (GROUP BY country_code,
-- country_name with an optional created_at range filter and a
-- country_code IS NOT NULL predicate). Partial index skips users with no
-- resolved country since the query always excludes them.
CREATE INDEX IF NOT EXISTS idx_users_country_created_at
    ON public.users (country_code, created_at)
    WHERE country_code IS NOT NULL;
