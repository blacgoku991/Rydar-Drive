-- =============================================================================
-- Rydar Drive — Stockage (Supabase Storage) : logos, photos, documents
-- Convention de chemin : {organization_id}/...   (documents : {org}/{driver_id}/...)
-- =============================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema absent — buckets ignorés (environnement local)';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
    ('org-assets', 'org-assets', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']),
    ('driver-photos', 'driver-photos', true, 5242880, array['image/png', 'image/jpeg', 'image/webp']),
    ('driver-documents', 'driver-documents', false, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'application/pdf'])
  on conflict (id) do nothing;

  execute $p$
    create policy rydar_storage_read_documents on storage.objects for select to authenticated
    using (
      bucket_id = 'driver-documents' and (
        (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
        or (storage.foldername(name))[2] = coalesce((select private.current_driver_id())::text, '-')
      )
    )
  $p$;
  execute $p$
    create policy rydar_storage_write on storage.objects for insert to authenticated
    with check (
      bucket_id in ('org-assets', 'driver-photos', 'driver-documents')
      and (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
    )
  $p$;
  execute $p$
    create policy rydar_storage_update on storage.objects for update to authenticated
    using (
      bucket_id in ('org-assets', 'driver-photos', 'driver-documents')
      and (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
    )
  $p$;
  execute $p$
    create policy rydar_storage_delete on storage.objects for delete to authenticated
    using (
      bucket_id in ('org-assets', 'driver-photos', 'driver-documents')
      and (storage.foldername(name))[1] in (select m::text from private.member_org_ids() as m)
    )
  $p$;
end;
$$;
