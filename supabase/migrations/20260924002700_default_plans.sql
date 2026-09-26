-- =============================================================================
-- Rydar Drive — Offres par défaut (Starter, Pro, Business)
-- Indispensables pour créer un rattacheur. Elles n'étaient fournies que par seed.sql,
-- jamais chargé en production : la liste « Offre » restait vide et la création échouait.
-- Une offre déjà présente (modifiée par le super admin dans /admin/plans) n'est pas touchée.
-- =============================================================================
insert into public.plans (code, name, description, price_monthly_cents, price_yearly_cents, limits, features, highlighted, sort_order)
values
  ('starter', 'Starter', 'Pour démarrer et quitter WhatsApp.', 4900, 49000,
   '{"max_drivers":10,"max_rides_per_month":500,"max_admins":2,"api_access":false,"booking_site":false,"custom_domain":false,"advanced_stats":false,"history_days":90}',
   array['Dispatch automatique 4 → 16 km', 'Application chauffeur iOS & Android', 'Carte temps réel', 'Jusqu''à 10 chauffeurs', '500 courses / mois'],
   false, 1),
  ('pro', 'Pro', 'Connectez votre site et automatisez tout.', 14900, 149000,
   '{"max_drivers":40,"max_rides_per_month":3000,"max_admins":5,"api_access":true,"booking_site":true,"custom_domain":false,"advanced_stats":true,"history_days":365}',
   array['Tout Starter', 'API de réservation', 'Mini-site de réservation', 'Statistiques avancées', 'Jusqu''à 40 chauffeurs'],
   true, 2),
  ('business', 'Business', 'Pour les centrales et grandes flottes.', 39900, 399000,
   '{"max_drivers":250,"max_rides_per_month":null,"max_admins":20,"api_access":true,"booking_site":true,"custom_domain":true,"advanced_stats":true,"history_days":null}',
   array['Tout Pro', 'Domaine personnalisé', 'Courses illimitées', 'Jusqu''à 250 chauffeurs', 'Support prioritaire'],
   false, 3)
on conflict (code) do nothing;
