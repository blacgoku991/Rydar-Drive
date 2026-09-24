-- =============================================================================
-- Rydar Drive — Droits d'exécution des fonctions (deny-by-default)
-- À répéter pour toute nouvelle fonction ajoutée dans une migration future.
-- =============================================================================

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function
  private.is_super_admin(),
  private.member_org_ids(),
  private.admin_org_ids(),
  private.membership_org_ids(),
  private.is_org_member(uuid),
  private.has_org_role(uuid, public.org_role[]),
  private.current_driver_id(),
  private.current_driver_org_id()
to authenticated;
grant execute on all functions in schema private to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;

-- Application chauffeur
grant execute on function
  public.accept_ride_offer(uuid),
  public.decline_ride_offer(uuid),
  public.driver_update_ride_status(uuid, public.ride_status),
  public.driver_set_online(boolean),
  public.update_driver_location(double precision, double precision, real, real, real, real, timestamptz),
  public.driver_register_device(text, public.device_platform, text, public.push_provider, text, text, text),
  public.driver_unregister_push_token(text),
  public.driver_home(),
  public.driver_offers()
to authenticated;

-- Dashboard rattacheur / super admin
grant execute on function
  public.cancel_ride(uuid, text),
  public.assign_ride(uuid, uuid),
  public.redispatch_ride(uuid),
  public.org_kpis(uuid),
  public.org_stats(uuid, timestamptz, timestamptz),
  public.driver_stats(uuid, integer),
  public.org_usage(uuid),
  public.platform_overview()
to authenticated;

-- Public (middleware mini-site)
grant execute on function public.resolve_booking_host(text, text) to anon, authenticated;

-- Serveur uniquement
grant execute on all functions in schema public to service_role;
