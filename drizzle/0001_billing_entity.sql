CREATE SCHEMA "billing";
--> statement-breakpoint
CREATE TABLE "billing"."owner_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_slug" text NOT NULL,
	"display_name" text NOT NULL,
	"stripe_account_id" text,
	"stripe_mode" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "owner_accounts_stripe_account_id_unique" UNIQUE("stripe_account_id"),
	CONSTRAINT "owner_accounts_stripe_mode_check" CHECK ("billing"."owner_accounts"."stripe_mode" in ('live', 'test'))
);
--> statement-breakpoint
ALTER TABLE "billing"."owner_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."tenant_members" (
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_members_tenant_id_email_pk" PRIMARY KEY("tenant_id","email"),
	CONSTRAINT "tenant_members_email_lowercase_check" CHECK ("billing"."tenant_members"."email" = lower("billing"."tenant_members"."email")),
	CONSTRAINT "tenant_members_role_check" CHECK ("billing"."tenant_members"."role" in ('client_viewer', 'client_admin', 'operator'))
);
--> statement-breakpoint
ALTER TABLE "billing"."tenant_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "billing"."tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"owner_account_id" text NOT NULL,
	"client_id" text,
	"stripe_customer_id" text,
	"display_name" text NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "tenants_owner_account_stripe_customer_unique" UNIQUE("owner_account_id","stripe_customer_id"),
	CONSTRAINT "tenants_kind_check" CHECK ("billing"."tenants"."kind" in ('client', 'owner'))
);
--> statement-breakpoint
ALTER TABLE "billing"."tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."tenant_members" ADD CONSTRAINT "tenant_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "billing"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing"."tenants" ADD CONSTRAINT "tenants_owner_account_id_owner_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "billing"."owner_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_members_email_idx" ON "billing"."tenant_members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "tenants_owner_account_idx" ON "billing"."tenants" USING btree ("owner_account_id");--> statement-breakpoint
CREATE POLICY "owner_accounts_read" ON "billing"."owner_accounts" AS PERMISSIVE FOR SELECT TO public USING ("billing"."owner_accounts"."id" in (select owner_account_id from billing.tenants));--> statement-breakpoint
CREATE POLICY "owner_accounts_insert" ON "billing"."owner_accounts" AS PERMISSIVE FOR INSERT TO public WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "owner_accounts_update" ON "billing"."owner_accounts" AS PERMISSIVE FOR UPDATE TO public USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "owner_accounts_delete" ON "billing"."owner_accounts" AS PERMISSIVE FOR DELETE TO public USING (true);--> statement-breakpoint
CREATE POLICY "tenant_members_read" ON "billing"."tenant_members" AS PERMISSIVE FOR SELECT TO public USING ("billing"."tenant_members"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid or "billing"."tenant_members"."email" = lower(nullif(current_setting('app.member_email', true), '')));--> statement-breakpoint
CREATE POLICY "tenant_members_insert" ON "billing"."tenant_members" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("billing"."tenant_members"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_members_update" ON "billing"."tenant_members" AS PERMISSIVE FOR UPDATE TO public USING ("billing"."tenant_members"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("billing"."tenant_members"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_members_delete" ON "billing"."tenant_members" AS PERMISSIVE FOR DELETE TO public USING ("billing"."tenant_members"."tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenants_read" ON "billing"."tenants" AS PERMISSIVE FOR SELECT TO public USING ("billing"."tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid or "billing"."tenants"."id" in (select tenant_id from billing.tenant_members where email = lower(nullif(current_setting('app.member_email', true), ''))));--> statement-breakpoint
CREATE POLICY "tenants_insert" ON "billing"."tenants" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("billing"."tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenants_update" ON "billing"."tenants" AS PERMISSIVE FOR UPDATE TO public USING ("billing"."tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("billing"."tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenants_delete" ON "billing"."tenants" AS PERMISSIVE FOR DELETE TO public USING ("billing"."tenants"."id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- FORCE, as the portal does on its own projection tables: the table owner (the
-- migrating role) obeys the policies too. Hand-added; drizzle does not model it.
ALTER TABLE "billing"."owner_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing"."tenant_members" FORCE ROW LEVEL SECURITY;
