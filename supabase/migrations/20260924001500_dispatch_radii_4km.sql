-- Vagues de dispatch par défaut : 4 km → 8 km → 12 km → 16 km.
-- Les organisations restées sur l'ancien défaut (3 → 5 → 8 → 12 km) passent au nouveau ;
-- celles qui ont personnalisé leurs rayons ne sont pas touchées.
alter table public.organization_settings
  alter column dispatch_radii_m set default '{4000,8000,12000,16000}';

update public.organization_settings
   set dispatch_radii_m = '{4000,8000,12000,16000}'
 where dispatch_radii_m = '{3000,5000,8000,12000}';
