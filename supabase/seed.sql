-- =============================================================================
-- Rydar Drive — Données de démonstration
--   Super admin        admin@rydar.app               Rydar!Admin2026
--   Rattacheur A       direction@elite-paris.fr      Rydar!Demo2026   (Élite Chauffeurs Paris, BUSINESS)
--   Dispatcher A       dispatch@elite-paris.fr       Rydar!Demo2026
--   Rattacheur B       contact@riviera-prestige.fr   Rydar!Demo2026   (Riviera Prestige VTC, STARTER)
--   Chauffeurs         mohamed@elite-paris.fr …      Rydar!Driver2026
--   Centrale (opt. 2)  contact@centrale-express.fr   Rydar!Demo2026   (Centrale Express Paris, centrale à commission)
--   Chauffeurs réseau  amine@centrale-express.fr …   Rydar!Driver2026 (inscription : /rejoindre/express2026demo)
-- L'historique (30 jours) est importé en mode « bypass » ; les courses du jour
-- passent par le VRAI moteur de dispatch (offres, acceptation, statuts).
-- =============================================================================

set client_min_messages = warning;
select setseed(0.42);

-- -----------------------------------------------------------------------------
-- Offres SaaS
-- -----------------------------------------------------------------------------
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
on conflict (code) do update set
  name = excluded.name, description = excluded.description, price_monthly_cents = excluded.price_monthly_cents,
  price_yearly_cents = excluded.price_yearly_cents, limits = excluded.limits, features = excluded.features,
  highlighted = excluded.highlighted, sort_order = excluded.sort_order;

-- -----------------------------------------------------------------------------
-- Comptes (auth.users compatible Supabase Auth / GoTrue)
-- -----------------------------------------------------------------------------
create or replace function pg_temp.seed_user(p_id uuid, p_email text, p_password text, p_name text)
returns uuid
language plpgsql
as $$
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', p_name), now(), now(),
    '', '', '', '', '', '', '', '')
  on conflict (id) do nothing;

  if to_regclass('auth.identities') is not null then
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    select gen_random_uuid(), p_id::text, p_id,
      jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true), 'email', now(), now(), now()
    where not exists (select 1 from auth.identities i where i.user_id = p_id and i.provider = 'email');
  end if;
  return p_id;
end;
$$;

do $$
begin
  perform pg_temp.seed_user('00000000-0000-4000-a000-000000000001', 'admin@rydar.app', 'Rydar!Admin2026', 'Équipe Rydar');
  perform pg_temp.seed_user('00000000-0000-4000-a000-000000000002', 'direction@elite-paris.fr', 'Rydar!Demo2026', 'Nadia Benhamou');
  perform pg_temp.seed_user('00000000-0000-4000-a000-000000000003', 'contact@riviera-prestige.fr', 'Rydar!Demo2026', 'Marc Giordano');
  perform pg_temp.seed_user('00000000-0000-4000-a000-000000000004', 'dispatch@elite-paris.fr', 'Rydar!Demo2026', 'Léa Fontaine');
end;
$$;

update public.users set is_super_admin = true where id = '00000000-0000-4000-a000-000000000001';

-- -----------------------------------------------------------------------------
-- Rattacheurs
-- -----------------------------------------------------------------------------
insert into public.organizations (id, name, slug, plan_id, legal_name, siret, email, phone, address, city, postal_code, brand_color, created_at)
values
  ('10000000-0000-4000-a000-00000000000a', 'Élite Chauffeurs Paris', 'elite-paris',
   (select id from public.plans where code = 'business'), 'Élite Chauffeurs SAS', '91234567800019',
   'direction@elite-paris.fr', '+33 1 84 60 12 12', '48 Avenue Victor Hugo', 'Paris', '75116', '#C8F03C', now() - interval '140 days'),
  ('10000000-0000-4000-a000-00000000000b', 'Riviera Prestige VTC', 'riviera-prestige',
   (select id from public.plans where code = 'starter'), 'Riviera Prestige SARL', '88765432100027',
   'contact@riviera-prestige.fr', '+33 4 93 12 45 45', '12 Quai des États-Unis', 'Nice', '06300', '#5EC8FF', now() - interval '60 days')
on conflict (id) do nothing;

insert into public.organization_users (organization_id, user_id, role) values
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000002', 'owner'),
  ('10000000-0000-4000-a000-00000000000a', '00000000-0000-4000-a000-000000000004', 'dispatcher'),
  ('10000000-0000-4000-a000-00000000000b', '00000000-0000-4000-a000-000000000003', 'owner')
on conflict do nothing;

update public.booking_sites set
  enabled = true,
  title = 'Élite Chauffeurs Paris',
  tagline = 'Chauffeur privé haut de gamme, 24 h/24',
  description = 'Transferts aéroports, gares, événements et mise à disposition à Paris et en Île-de-France.',
  primary_color = '#C8F03C',
  phone = '+33 1 84 60 12 12',
  email = 'reservation@elite-paris.fr',
  whatsapp = '+33 6 12 34 56 78',
  service_area = 'Paris, Île-de-France, aéroports CDG · Orly · Le Bourget · Beauvais',
  vehicle_categories = '{standard,business,van,first}'
where organization_id = '10000000-0000-4000-a000-00000000000a';

insert into public.pricing_rules (organization_id, name, vehicle_category, base_fare_cents, per_km_cents, per_minute_cents, minimum_fare_cents, night_surcharge_percent, fixed_fares)
values
  ('10000000-0000-4000-a000-00000000000a', 'Berline', 'standard', 800, 180, 45, 2500, 15, '[{"label":"Paris ↔ CDG","price_cents":6500},{"label":"Paris ↔ Orly","price_cents":5000}]'),
  ('10000000-0000-4000-a000-00000000000a', 'Business', 'business', 1200, 220, 55, 3500, 15, '[{"label":"Paris ↔ CDG","price_cents":7900},{"label":"Paris ↔ Orly","price_cents":6500}]'),
  ('10000000-0000-4000-a000-00000000000a', 'Van', 'van', 1500, 260, 60, 4500, 15, '[{"label":"Paris ↔ CDG","price_cents":9500},{"label":"Paris ↔ Disneyland","price_cents":9500}]'),
  ('10000000-0000-4000-a000-00000000000a', 'Prestige', 'first', 2500, 380, 80, 8000, 10, '[{"label":"Paris ↔ CDG","price_cents":14000}]'),
  ('10000000-0000-4000-a000-00000000000b', 'Berline', 'standard', 900, 200, 45, 3000, 20, '[{"label":"Nice ↔ Aéroport","price_cents":4000},{"label":"Nice ↔ Monaco","price_cents":9000}]')
on conflict do nothing;

insert into public.subscriptions (organization_id, plan_id, status, billing_interval, current_period_start, current_period_end)
select o.id, o.plan_id, case when o.slug = 'elite-paris' then 'active' else 'trialing' end::public.subscription_status, 'month',
       date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
from public.organizations o
where o.id in ('10000000-0000-4000-a000-00000000000a', '10000000-0000-4000-a000-00000000000b')
  and not exists (select 1 from public.subscriptions s where s.organization_id = o.id);

insert into public.invoices (organization_id, number, status, amount_due_cents, amount_paid_cents, period_start, period_end, created_at)
select '10000000-0000-4000-a000-00000000000a', 'RYD-2026-' || lpad(g::text, 4, '0'), 'paid', 39900, 39900,
       date_trunc('month', now()) - make_interval(months => g), date_trunc('month', now()) - make_interval(months => g - 1),
       date_trunc('month', now()) - make_interval(months => g) + interval '1 hour'
from generate_series(1, 4) g
where not exists (select 1 from public.invoices where organization_id = '10000000-0000-4000-a000-00000000000a');

-- -----------------------------------------------------------------------------
-- Flottes : véhicules + chauffeurs (+ comptes)
-- -----------------------------------------------------------------------------
create temp table seed_fleet (
  org uuid, idx int, first_name text, last_name text, phone text, email text,
  brand text, model text, color text, plate text, category public.vehicle_category, seats int,
  lat double precision, lng double precision, online boolean
);

insert into seed_fleet values
  ('10000000-0000-4000-a000-00000000000a', 1, 'Mohamed', 'Benali', '+33 6 12 45 78 90', 'mohamed@elite-paris.fr', 'Mercedes-Benz', 'Classe E 300e', 'Noir obsidienne', 'GH-482-KT', 'business', 4, 48.8718, 2.3010, true),
  ('10000000-0000-4000-a000-00000000000a', 2, 'Karim', 'Haddad', '+33 6 23 56 89 01', 'karim@elite-paris.fr', 'Mercedes-Benz', 'Classe E 220d', 'Noir', 'FT-219-LM', 'business', 4, 48.8664, 2.3045, true),
  ('10000000-0000-4000-a000-00000000000a', 3, 'Julien', 'Moreau', '+33 6 34 67 90 12', 'julien@elite-paris.fr', 'Mercedes-Benz', 'Classe V 250', 'Gris graphite', 'HB-731-QS', 'van', 7, 48.8460, 2.3720, true),
  ('10000000-0000-4000-a000-00000000000a', 4, 'Sofiane', 'Amrani', '+33 6 45 78 01 23', 'sofiane@elite-paris.fr', 'BMW', 'Série 5 530e', 'Noir saphir', 'GK-904-PR', 'business', 4, 48.8735, 2.3290, true),
  ('10000000-0000-4000-a000-00000000000a', 5, 'Thomas', 'Laurent', '+33 6 56 89 12 34', 'thomas@elite-paris.fr', 'Tesla', 'Model 3 Grande Autonomie', 'Noir', 'GR-118-XA', 'green', 4, 48.8790, 2.2870, true),
  ('10000000-0000-4000-a000-00000000000a', 6, 'Ibrahima', 'Diallo', '+33 6 67 90 23 45', 'ibrahima@elite-paris.fr', 'Mercedes-Benz', 'Vito Tourer', 'Noir', 'FZ-642-NB', 'van', 8, 48.8420, 2.3650, true),
  ('10000000-0000-4000-a000-00000000000a', 7, 'Nicolas', 'Petit', '+33 6 78 01 34 56', 'nicolas@elite-paris.fr', 'Toyota', 'Camry Hybride', 'Gris', 'GA-275-CD', 'standard', 4, 48.8930, 2.2400, true),
  ('10000000-0000-4000-a000-00000000000a', 8, 'Yanis', 'Belkacem', '+33 6 89 12 45 67', 'yanis@elite-paris.fr', 'Mercedes-Benz', 'EQE 350', 'Argent', 'HD-503-VT', 'business', 4, 48.8950, 2.2250, true),
  ('10000000-0000-4000-a000-00000000000a', 9, 'Alexandre', 'Martin', '+33 6 90 23 56 78', 'alexandre@elite-paris.fr', 'Mercedes-Benz', 'Classe S 580', 'Noir', 'HF-001-EL', 'first', 4, 48.8568, 2.3120, false),
  ('10000000-0000-4000-a000-00000000000a', 10, 'Samir', 'Ouali', '+33 6 01 34 67 89', 'samir@elite-paris.fr', 'Skoda', 'Superb iV', 'Noir', 'GB-846-JK', 'standard', 4, 48.8810, 2.3560, true),
  ('10000000-0000-4000-a000-00000000000a', 11, 'Lucas', 'Bernard', '+33 6 11 22 33 44', 'lucas@elite-paris.fr', 'Audi', 'A6 Avant e-tron', 'Gris Daytona', 'HC-377-WX', 'business', 4, 48.8400, 2.3200, true),
  ('10000000-0000-4000-a000-00000000000a', 12, 'Mehdi', 'Cherif', '+33 6 22 33 44 55', 'mehdi@elite-paris.fr', 'BMW', 'i7 xDrive60', 'Noir carbone', 'HG-777-PR', 'first', 4, 48.8662, 2.2980, false),
  ('10000000-0000-4000-a000-00000000000a', 13, 'Antoine', 'Rousseau', '+33 6 33 44 55 66', 'antoine@elite-paris.fr', 'Peugeot', '508 Hybrid', 'Noir perla', 'FY-908-GH', 'standard', 4, 48.8500, 2.3900, false),
  ('10000000-0000-4000-a000-00000000000a', 14, 'Ousmane', 'Traoré', '+33 6 44 55 66 77', 'ousmane@elite-paris.fr', 'Mercedes-Benz', 'Classe E 300de', 'Noir', 'GJ-561-BZ', 'business', 4, 48.8315, 2.3560, false),
  ('10000000-0000-4000-a000-00000000000b', 1, 'Lorenzo', 'Bianchi', '+33 6 55 66 77 88', 'lorenzo@riviera-prestige.fr', 'Mercedes-Benz', 'Classe E 220d', 'Noir', 'GL-406-NC', 'business', 4, 43.6960, 7.2650, true),
  ('10000000-0000-4000-a000-00000000000b', 2, 'Hugo', 'Martinez', '+33 6 66 77 88 99', 'hugo@riviera-prestige.fr', 'Mercedes-Benz', 'Classe V 300d', 'Noir', 'GM-512-AZ', 'van', 7, 43.6620, 7.2150, true),
  ('10000000-0000-4000-a000-00000000000b', 3, 'Rayan', 'Messaoudi', '+33 6 77 88 99 00', 'rayan@riviera-prestige.fr', 'Tesla', 'Model S Plaid', 'Blanc nacré', 'GN-230-MC', 'first', 4, 43.7390, 7.4240, true),
  ('10000000-0000-4000-a000-00000000000b', 4, 'Paul', 'Garnier', '+33 6 88 99 00 11', 'paul@riviera-prestige.fr', 'Toyota', 'Corolla Touring', 'Gris', 'GP-884-CA', 'standard', 4, 43.5520, 7.0180, false),
  ('10000000-0000-4000-a000-00000000000b', 5, 'Nabil', 'Saidi', '+33 6 99 00 11 22', 'nabil@riviera-prestige.fr', 'BMW', 'Série 5 520d', 'Noir', 'GQ-129-AN', 'business', 4, 43.7000, 7.2800, false);

do $$
declare
  f record;
  v_user uuid;
  v_vehicle uuid;
  v_driver uuid;
begin
  for f in select * from seed_fleet order by org, idx loop
    if exists (select 1 from public.drivers where lower(email) = lower(f.email)) then
      continue;
    end if;
    v_user := pg_temp.seed_user(gen_random_uuid(), f.email, 'Rydar!Driver2026', f.first_name || ' ' || f.last_name);
    insert into public.vehicles (organization_id, brand, model, color, plate, category, seats, luggage_capacity, year)
    values (f.org, f.brand, f.model, f.color, f.plate, f.category, f.seats, case when f.category = 'van' then 7 else 3 end, 2022 + (f.idx % 4))
    returning id into v_vehicle;
    insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence, vehicle_id,
      vtc_card_number, online_since, created_at)
    values (f.org, v_user, f.first_name, f.last_name, f.phone, f.email, 'active',
      case when f.online then 'available' else 'offline' end::public.driver_presence, v_vehicle,
      'VTC-' || (750000 + f.idx * 137)::text, case when f.online then now() - make_interval(mins => 20 + f.idx * 7) end,
      now() - make_interval(days => 120 - f.idx * 3))
    returning id into v_driver;
    insert into public.driver_locations (driver_id, organization_id, lat, lng, heading, speed_mps, accuracy_m, battery_level, recorded_at, updated_at)
    values (v_driver, f.org, f.lat, f.lng, (f.idx * 47) % 360, case when f.online then 0 else null end, 8, 0.4 + (f.idx % 6) / 10.0,
      case when f.online then now() else now() - interval '3 hours' end,
      case when f.online then now() else now() - interval '3 hours' end);
    insert into public.driver_documents (organization_id, driver_id, type, label, number, expires_at, status) values
      (f.org, v_driver, 'vtc_card', 'Carte VTC', 'VTC-' || (750000 + f.idx * 137)::text, current_date + (200 + f.idx * 30), 'valid'),
      (f.org, v_driver, 'driving_license', 'Permis B', 'B-' || (120000 + f.idx), current_date + 2000, 'valid'),
      (f.org, v_driver, 'insurance', 'Assurance RC Pro', 'RCP-' || (5000 + f.idx), current_date + (15 + f.idx * 20), 'valid');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Historique 30 jours (import direct, sans déclencher le moteur)
-- -----------------------------------------------------------------------------
do $$
declare
  v_org record;
  v_pois jsonb;
  v_customers text[] := array[
    'M. Laurent Dubois', 'Mme Claire Fontaine', 'Hôtel Le Bristol — M. Tanaka', 'Sophie Marchand', 'Groupe Aurel — Mme Rossi',
    'M. Hugo Lefèvre', 'Mme Inès Garnier', 'Four Seasons George V — Mr. Walker', 'M. Karim Saïdi', 'Mme Emma Leroy',
    'Cabinet Delsol — M. Perrin', 'Mme Chloé Lambert', 'M. Arthur Blanc', 'Shangri-La — Mrs. Chen', 'M. Nathan Robert',
    'Mme Julie Mercier', 'Conciergerie Lutèce — M. Faure', 'M. Pierre Girard', 'Mme Sarah Cohen', 'M. David Klein'
  ];
  v_hour_weights int[] := array[2,1,1,1,2,4,8,10,9,6,5,5,6,5,5,6,8,10,11,9,7,5,4,3];
  v_total_weight int;
  v_days int;
  v_per_day int;
  v_drivers uuid[];
  v_driver record;
  v_day date;
  v_hour int;
  v_acc int;
  v_rand double precision;
  v_pick int;
  v_drop int;
  v_p jsonb;
  v_d jsonb;
  v_pickup timestamptz;
  v_created timestamptz;
  v_accept timestamptz;
  v_dist_km double precision;
  v_price int;
  v_status public.ride_status;
  v_source public.ride_source;
  v_ride uuid;
  v_offer uuid;
  v_candidates int;
  v_online int;
  v_offer_dist int;
  v_tz text := 'Europe/Paris';
  i int;
  k int;
  day_ago int;
begin
  perform set_config('rydar.bypass_ride_rules', 'on', false);
  select sum(w) into v_total_weight from unnest(v_hour_weights) as w;

  for v_org in select * from public.organizations
               where id in ('10000000-0000-4000-a000-00000000000a', '10000000-0000-4000-a000-00000000000b') loop
    if exists (select 1 from public.rides where organization_id = v_org.id) then
      continue;
    end if;

    if v_org.slug = 'elite-paris' then
      v_pois := '[
        {"a":"Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France","lat":49.0047,"lng":2.5710,"air":true},
        {"a":"Aéroport de Paris-Orly, Terminal 4, 94390 Orly","lat":48.7262,"lng":2.3652,"air":true},
        {"a":"12 Avenue des Champs-Élysées, 75008 Paris","lat":48.8698,"lng":2.3075},
        {"a":"Hôtel Plaza Athénée, 25 Avenue Montaigne, 75008 Paris","lat":48.8663,"lng":2.3040},
        {"a":"Gare de Lyon, Place Louis-Armand, 75012 Paris","lat":48.8443,"lng":2.3743},
        {"a":"La Défense, Parvis de la Défense, 92400 Courbevoie","lat":48.8924,"lng":2.2360},
        {"a":"Gare du Nord, 18 Rue de Dunkerque, 75010 Paris","lat":48.8809,"lng":2.3553},
        {"a":"Opéra Garnier, Place de l''Opéra, 75009 Paris","lat":48.8720,"lng":2.3316},
        {"a":"Gare Montparnasse, 17 Boulevard de Vaugirard, 75015 Paris","lat":48.8414,"lng":2.3209},
        {"a":"Disneyland Paris, Boulevard de Parc, 77700 Coupvray","lat":48.8722,"lng":2.7758},
        {"a":"Château de Versailles, Place d''Armes, 78000 Versailles","lat":48.8049,"lng":2.1204},
        {"a":"Palais des Congrès, 2 Place de la Porte Maillot, 75017 Paris","lat":48.8785,"lng":2.2830},
        {"a":"Hôtel Le Bristol, 112 Rue du Faubourg Saint-Honoré, 75008 Paris","lat":48.8718,"lng":2.3149},
        {"a":"Place de la Bastille, 75011 Paris","lat":48.8532,"lng":2.3692},
        {"a":"Aéroport Paris-Le Bourget, 93350 Le Bourget","lat":48.9614,"lng":2.4376,"air":true},
        {"a":"80 Avenue Charles de Gaulle, 92200 Neuilly-sur-Seine","lat":48.8847,"lng":2.2697},
        {"a":"170 Boulevard Saint-Germain, 75006 Paris","lat":48.8539,"lng":2.3337},
        {"a":"Tour Eiffel, 5 Avenue Anatole France, 75007 Paris","lat":48.8584,"lng":2.2945}
      ]';
      v_days := 30;
    else
      v_pois := '[
        {"a":"Aéroport Nice Côte d''Azur, Terminal 2, 06200 Nice","lat":43.6584,"lng":7.2159,"air":true},
        {"a":"37 Promenade des Anglais, 06000 Nice","lat":43.6947,"lng":7.2567},
        {"a":"Place du Casino, 98000 Monaco","lat":43.7392,"lng":7.4277},
        {"a":"Boulevard de la Croisette, 06400 Cannes","lat":43.5496,"lng":7.0303},
        {"a":"Cours Saleya, 06300 Nice","lat":43.6955,"lng":7.2757},
        {"a":"Port Vauban, 06600 Antibes","lat":43.5850,"lng":7.1280}
      ]';
      v_days := 30;
    end if;

    select array_agg(id order by number) into v_drivers from public.drivers where organization_id = v_org.id;

    for day_ago in reverse v_days..0 loop
      v_day := (now() at time zone v_tz)::date - day_ago;
      v_per_day := case when v_org.slug = 'elite-paris' then 16 else 5 end
                   + floor(random() * case when v_org.slug = 'elite-paris' then 10 else 4 end)::int
                   + case when extract(isodow from v_day) in (5, 6) then case when v_org.slug = 'elite-paris' then 7 else 2 end else 0 end;

      for i in 1..v_per_day loop
        v_rand := random() * v_total_weight;
        v_acc := 0;
        v_hour := 23;
        for k in 1..24 loop
          v_acc := v_acc + v_hour_weights[k];
          if v_rand < v_acc then v_hour := k - 1; exit; end if;
        end loop;

        v_pickup := (v_day::timestamp + make_interval(hours => v_hour, mins => floor(random() * 60)::int)) at time zone v_tz;
        continue when v_pickup > now() - interval '40 minutes';

        v_pick := floor(random() * jsonb_array_length(v_pois))::int;
        v_drop := floor(random() * jsonb_array_length(v_pois))::int;
        if v_drop = v_pick then v_drop := (v_pick + 1 + floor(random() * 3)::int) % jsonb_array_length(v_pois); end if;
        v_p := v_pois -> v_pick;
        v_d := v_pois -> v_drop;

        k := 1 + floor(random() * array_length(v_drivers, 1))::int;
        select d.id, d.first_name, d.vehicle_id, v.category, v.seats into v_driver from public.drivers d
        join public.vehicles v on v.id = d.vehicle_id
        where d.id = v_drivers[k];

        v_dist_km := 1.35 * 111.32 * sqrt(power((v_p ->> 'lat')::float - (v_d ->> 'lat')::float, 2)
                     + power(((v_p ->> 'lng')::float - (v_d ->> 'lng')::float) * cos(radians((v_p ->> 'lat')::float)), 2));
        v_price := greatest(2500, round((1200 + v_dist_km * 210) / 500.0) * 500)::int
                   * case v_driver.category when 'first' then 2 when 'van' then 1.3 when 'standard' then 0.85 else 1 end;
        v_price := (round(v_price / 100.0) * 100)::int;

        v_rand := random();
        v_status := case when v_rand < 0.87 then 'COMPLETED' when v_rand < 0.94 then 'CANCELLED' when v_rand < 0.975 then 'NO_DRIVER_FOUND' else 'COMPLETED' end::public.ride_status;
        v_rand := random();
        v_source := case when v_rand < 0.58 then 'dashboard' when v_rand < 0.88 then 'api' else 'booking_site' end::public.ride_source;
        v_created := v_pickup - case when random() < 0.62 then make_interval(mins => 2 + floor(random() * 10)::int)
                                     else make_interval(hours => 2 + floor(random() * 40)::int) end;
        v_accept := v_created + make_interval(secs => 4 + floor(random() * 38)::int);
        v_online := 6 + floor(random() * 8)::int;
        v_candidates := 1 + floor(random() * 5)::int;

        insert into public.rides (
          organization_id, type, status, source, dispatch_mode, pickup_address, pickup_lat, pickup_lng,
          dropoff_address, dropoff_lat, dropoff_lng, pickup_at, customer_name, customer_phone, passengers, luggage,
          vehicle_category, price_cents, payment_method, flight_number, estimated_distance_m, estimated_duration_s,
          driver_id, vehicle_id, dispatch_wave, dispatch_radius_m, dispatch_started_at, offered_at, accepted_at,
          driver_en_route_at, driver_arrived_at, passenger_onboard_at, started_at, completed_at, cancelled_at, no_driver_at,
          cancel_reason, cancelled_by_type, created_by, created_at, updated_at)
        values (
          v_org.id,
          case when v_pickup - v_created > interval '45 minutes' then 'scheduled' else 'instant' end::public.ride_type,
          v_status, v_source,
          case when v_pickup - v_created > interval '45 minutes' then 'fleet' else 'geo' end::public.dispatch_mode,
          v_p ->> 'a', (v_p ->> 'lat')::float, (v_p ->> 'lng')::float,
          v_d ->> 'a', (v_d ->> 'lat')::float, (v_d ->> 'lng')::float,
          v_pickup, v_customers[1 + floor(random() * array_length(v_customers, 1))::int],
          '+33 6 ' || lpad(floor(random() * 100)::text, 2, '0') || ' ' || lpad(floor(random() * 100)::text, 2, '0') || ' '
            || lpad(floor(random() * 100)::text, 2, '0') || ' ' || lpad(floor(random() * 100)::text, 2, '0'),
          1 + floor(random() * least(v_driver.seats, 4))::int, floor(random() * 4)::int,
          v_driver.category, v_price,
          (array['card','card','card','online','invoice','cash','account'])[1 + floor(random() * 7)::int]::public.payment_method,
          case when coalesce((v_p ->> 'air')::boolean, false) then (array['AF','EK','BA','DL','QR','LH'])[1 + floor(random() * 6)::int] || (100 + floor(random() * 900)::int) end,
          (v_dist_km * 1000)::int, (v_dist_km * 110 + 300)::int,
          case when v_status = 'COMPLETED' then v_driver.id end,
          case when v_status = 'COMPLETED' then v_driver.vehicle_id end,
          case when v_status = 'NO_DRIVER_FOUND' then 4 else 1 end,
          case when v_status = 'NO_DRIVER_FOUND' then 16000 else 4000 end,
          v_created, v_created + interval '1 second',
          case when v_status = 'COMPLETED' then v_accept end,
          case when v_status = 'COMPLETED' then v_pickup - interval '14 minutes' end,
          case when v_status = 'COMPLETED' then v_pickup - interval '2 minutes' end,
          case when v_status = 'COMPLETED' then v_pickup + interval '1 minute' end,
          case when v_status = 'COMPLETED' then v_pickup + interval '2 minutes' end,
          case when v_status = 'COMPLETED' then v_pickup + make_interval(secs => (v_dist_km * 110 + 400)::int) end,
          case when v_status = 'CANCELLED' then v_created + interval '6 minutes' end,
          case when v_status = 'NO_DRIVER_FOUND' then v_created + interval '5 minutes' end,
          case when v_status = 'CANCELLED' then (array['Client injoignable','Vol annulé','Doublon','Annulé par le client'])[1 + floor(random() * 4)::int] end,
          case when v_status = 'CANCELLED' then 'user'::public.actor_type end,
          case when v_source = 'dashboard' then (array['00000000-0000-4000-a000-000000000002','00000000-0000-4000-a000-000000000004'])[1 + floor(random() * 2)::int]::uuid end,
          v_created, coalesce(v_pickup + interval '1 hour', v_created))
        returning id into v_ride;

        -- Offres + journal condensé
        if v_status = 'COMPLETED' then
          v_offer_dist := 250 + floor(random() * 2700)::int;
          insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, expires_at, responded_at)
          values (v_org.id, v_ride, v_driver.id, 'accepted', 'geo', 1, 4000, v_offer_dist, v_created + interval '1 second',
                  v_created + interval '31 seconds', v_accept)
          returning id into v_offer;
          insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, expires_at, responded_at, closed_reason)
          select v_org.id, v_ride, x.id,
                 case when random() < 0.15 then 'declined' else 'closed' end::public.offer_status,
                 'geo', 1, 4000, 400 + floor(random() * 3500)::int, v_created + interval '1 second', v_created + interval '31 seconds', v_accept,
                 'assigned_to_other'
          from (select id from public.drivers where organization_id = v_org.id and id <> v_driver.id order by random() limit v_candidates - 1) x;
          insert into public.ride_assignments (organization_id, ride_id, driver_id, vehicle_id, offer_id, method, assigned_at)
          values (v_org.id, v_ride, v_driver.id, v_driver.vehicle_id, v_offer, 'accepted', v_accept);
        elsif v_status = 'NO_DRIVER_FOUND' then
          -- offres restées sans réponse : « manquées » dans les statistiques (missed_at, migr. 002050)
          insert into public.ride_offers (organization_id, ride_id, driver_id, status, mode, wave, radius_m, distance_m, sent_at, expires_at, responded_at, closed_reason, missed_at)
          select v_org.id, v_ride, x.id, 'expired', 'geo', 3, 12000, 8500 + floor(random() * 3500)::int,
                 v_created + interval '61 seconds', v_created + interval '91 seconds', v_created + interval '91 seconds', 'timeout',
                 v_created + interval '91 seconds'
          from (select id from public.drivers where organization_id = v_org.id order by random() limit 2) x;
        end if;

        insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, data, created_at)
        values
          (v_org.id, v_ride, 'timeline', 'info', 'ride.created',
           case v_source when 'api' then 'Course reçue via l''API (site du rattacheur)' when 'booking_site' then 'Course reçue via le site de réservation' else 'Course créée par le rattacheur' end,
           case v_source when 'api' then 'api' when 'booking_site' then 'booking_site' else 'user' end::public.actor_type, '{}', v_created),
          (v_org.id, v_ride, 'timeline', 'info', 'dispatch.search', 'Recherche GPS — rayon 4 km (vague 1)', 'system', '{"wave":1,"radius_m":4000}', v_created + interval '400 milliseconds'),
          (v_org.id, v_ride, 'timeline', 'info', 'dispatch.online', format('%s chauffeurs en ligne', v_online), 'system', jsonb_build_object('online', v_online), v_created + interval '450 milliseconds'),
          (v_org.id, v_ride, 'timeline', case when v_status = 'NO_DRIVER_FOUND' then 'warning' else 'info' end::public.event_level, 'dispatch.candidates',
           format('%s %s à moins de 4 km', case when v_status = 'NO_DRIVER_FOUND' then 0 else v_candidates end,
             private.pl(case when v_status = 'NO_DRIVER_FOUND' then 0 else v_candidates end, 'chauffeur', 'chauffeurs')),
           'system', jsonb_build_object('candidates', v_candidates), v_created + interval '900 milliseconds');

        if v_status = 'COMPLETED' then
          insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, actor_id, data, created_at)
          values
            (v_org.id, v_ride, 'timeline', 'success', 'dispatch.notified', format('%s %s', v_candidates, private.pl(v_candidates, 'notification envoyée', 'notifications envoyées')), 'system', null, '{}', v_created + interval '1 second'),
            (v_org.id, v_ride, 'timeline', 'success', 'offer.accepted', v_driver.first_name || ' accepte', 'driver', v_driver.id,
             jsonb_build_object('driver_id', v_driver.id, 'distance_m', v_offer_dist, 'response_ms', extract(epoch from (v_accept - v_created)) * 1000), v_accept),
            (v_org.id, v_ride, 'timeline', 'info', 'ride.locked', 'Course verrouillée', 'system', null, '{}', v_accept + interval '20 milliseconds'),
            (v_org.id, v_ride, 'timeline', 'success', 'ride.completed', 'Course terminée', 'driver', v_driver.id, '{}',
             v_pickup + make_interval(secs => (v_dist_km * 110 + 400)::int));
        elsif v_status = 'CANCELLED' then
          insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, data, created_at)
          values (v_org.id, v_ride, 'timeline', 'warning', 'ride.cancelled', 'Course annulée', 'user', '{}', v_created + interval '6 minutes');
        else
          insert into public.ride_events (organization_id, ride_id, category, level, type, message, actor_type, data, created_at)
          values (v_org.id, v_ride, 'timeline', 'error', 'dispatch.no_driver', 'Aucun chauffeur trouvé — recherche arrêtée après 5 min', 'system', '{}', v_created + interval '5 minutes');
        end if;

        insert into public.ride_status_history (organization_id, ride_id, from_status, to_status, actor_type, created_at)
        values (v_org.id, v_ride, null, 'CREATED', 'system', v_created),
               (v_org.id, v_ride, 'CREATED', 'SEARCHING_DRIVER', 'system', v_created + interval '300 milliseconds'),
               (v_org.id, v_ride, 'SEARCHING_DRIVER', v_status, 'system', coalesce(v_accept, v_created + interval '5 minutes'));
      end loop;
    end loop;
  end loop;

  perform set_config('rydar.bypass_ride_rules', 'off', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Activité du jour : via le VRAI moteur de dispatch
-- -----------------------------------------------------------------------------
create or replace function pg_temp.as_driver(p_email text)
returns void
language sql
as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', (select user_id from public.drivers where lower(email) = lower(p_email)), 'role', 'authenticated')::text, false);
$$;

create or replace function pg_temp.reset_claims()
returns void
language sql
as $$
  select set_config('request.jwt.claims', '', false);
$$;

create or replace function pg_temp.new_ride(
  p_org uuid, p_source public.ride_source, p_pickup text, p_plat float, p_plng float, p_drop text, p_dlat float, p_dlng float,
  p_at timestamptz, p_customer text, p_pax int, p_cat public.vehicle_category, p_price int, p_flight text default null, p_comment text default null)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  perform pg_temp.reset_claims();
  insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
    pickup_at, customer_name, customer_phone, passengers, luggage, vehicle_category, price_cents, payment_method, flight_number, comment,
    created_by, estimated_distance_m, estimated_duration_s)
  values (p_org, p_source, p_pickup, p_plat, p_plng, p_drop, p_dlat, p_dlng, p_at, p_customer, '+33 6 71 42 98 10', p_pax,
    least(p_pax, 3), p_cat, p_price, 'card', p_flight, p_comment,
    case when p_source = 'dashboard' then '00000000-0000-4000-a000-000000000004'::uuid end,
    (111320 * 1.3 * sqrt(power(p_plat - p_dlat, 2) + power((p_plng - p_dlng) * cos(radians(p_plat)), 2)))::int,
    (111320 * 1.3 * sqrt(power(p_plat - p_dlat, 2) + power((p_plng - p_dlng) * cos(radians(p_plat)), 2)) / 9)::int)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function pg_temp.accept_as(p_email text, p_ride uuid)
returns jsonb
language plpgsql
as $$
declare
  v_res jsonb;
begin
  perform pg_temp.as_driver(p_email);
  select public.accept_ride_offer(o.id) into v_res
  from public.ride_offers o join public.drivers d on d.id = o.driver_id
  where o.ride_id = p_ride and lower(d.email) = lower(p_email);
  perform pg_temp.reset_claims();
  return v_res;
end;
$$;

create or replace function pg_temp.advance_as(p_email text, p_ride uuid, p_status public.ride_status[])
returns void
language plpgsql
as $$
declare
  s public.ride_status;
begin
  perform pg_temp.as_driver(p_email);
  foreach s in array p_status loop
    perform public.driver_update_ride_status(p_ride, s);
  end loop;
  perform pg_temp.reset_claims();
end;
$$;

do $$
declare
  a uuid := '10000000-0000-4000-a000-00000000000a';
  b uuid := '10000000-0000-4000-a000-00000000000b';
  r uuid;
  v_tomorrow timestamptz := date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' + interval '1 day';
begin
  if exists (select 1 from public.rides where organization_id = a and created_at > now() - interval '5 minutes' and source = 'dashboard' and status <> 'COMPLETED') then
    return;
  end if;

  -- Positions fraîches pour la flotte en ligne
  update public.driver_locations l set updated_at = now(), recorded_at = now()
  from public.drivers d where d.id = l.driver_id and d.presence <> 'offline';

  -- 1. Plaza Athénée → CDG, en cours
  r := pg_temp.new_ride(a, 'api', 'Hôtel Plaza Athénée, 25 Avenue Montaigne, 75008 Paris', 48.8663, 2.3040,
    'Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France', 49.0047, 2.5710,
    now(), 'Four Seasons George V — Mr. Walker', 2, 'business', 7900, 'AF218');
  perform pg_temp.accept_as('karim@elite-paris.fr', r);
  perform pg_temp.advance_as('karim@elite-paris.fr', r, array['DRIVER_EN_ROUTE','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS']::public.ride_status[]);
  update public.driver_locations set lat = 48.9120, lng = 2.3890, heading = 55, speed_mps = 24 where driver_id = (select id from public.drivers where email = 'karim@elite-paris.fr');

  -- 2. Gare de Lyon → Disneyland, van, chauffeur en route
  r := pg_temp.new_ride(a, 'dashboard', 'Gare de Lyon, Place Louis-Armand, 75012 Paris', 48.8443, 2.3743,
    'Disneyland Paris, Boulevard de Parc, 77700 Coupvray', 48.8722, 2.7758,
    now(), 'Famille Martin', 6, 'van', 9500, null, 'Deux sièges enfant nécessaires');
  perform pg_temp.accept_as('julien@elite-paris.fr', r);
  perform pg_temp.advance_as('julien@elite-paris.fr', r, array['DRIVER_EN_ROUTE']::public.ride_status[]);

  -- 3. Opéra → Versailles, client à bord
  r := pg_temp.new_ride(a, 'booking_site', 'Opéra Garnier, Place de l''Opéra, 75009 Paris', 48.8720, 2.3316,
    'Château de Versailles, Place d''Armes, 78000 Versailles', 48.8049, 2.1204,
    now(), 'Mme Claire Fontaine', 3, 'business', 8500);
  perform pg_temp.accept_as('sofiane@elite-paris.fr', r);
  perform pg_temp.advance_as('sofiane@elite-paris.fr', r, array['DRIVER_EN_ROUTE','DRIVER_ARRIVED','PASSENGER_ONBOARD']::public.ride_status[]);

  -- 4. Demain 06:30 Avenue Foch → CDG, planifiée et attribuée (rappels programmés)
  r := pg_temp.new_ride(a, 'dashboard', '72 Avenue Foch, 75116 Paris', 48.8718, 2.2830,
    'Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France', 49.0047, 2.5710,
    v_tomorrow + interval '6 hours 30 minutes', 'M. Laurent Dubois', 1, 'business', 7900, 'AF1680', 'Client VIP — journal Les Échos');
  perform pg_temp.accept_as('mohamed@elite-paris.fr', r);

  -- 5. La Défense → Orly : instantanée, offres en cours
  r := pg_temp.new_ride(a, 'api', 'La Défense, Parvis de la Défense, 92400 Courbevoie', 48.8924, 2.2360,
    'Aéroport de Paris-Orly, Terminal 4, 94390 Orly', 48.7262, 2.3652,
    now(), 'Groupe Aurel — Mme Rossi', 2, 'business', 7000, 'TO3120');

  -- 6. Demain 14:00 Gare du Nord → Le Bourget : planifiée, proposée à la flotte
  r := pg_temp.new_ride(a, 'dashboard', 'Gare du Nord, 18 Rue de Dunkerque, 75010 Paris', 48.8809, 2.3553,
    'Aéroport Paris-Le Bourget, 93350 Le Bourget', 48.9614, 2.4376,
    v_tomorrow + interval '14 hours', 'Cabinet Delsol — M. Perrin', 2, 'business', 6000);

  -- 7. Dans 3 jours Disneyland → CDG : van, proposée à la flotte
  r := pg_temp.new_ride(a, 'booking_site', 'Disneyland Paris, Boulevard de Parc, 77700 Coupvray', 48.8722, 2.7758,
    'Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France', 49.0047, 2.5710,
    v_tomorrow + interval '2 days 11 hours', 'Famille Nakamura', 7, 'van', 9500, 'JL046');

  -- 8. Prestige demandé sans Classe S en ligne → aucun chauffeur
  r := pg_temp.new_ride(a, 'dashboard', 'Hôtel Le Bristol, 112 Rue du Faubourg Saint-Honoré, 75008 Paris', 48.8718, 2.3149,
    'Aéroport Paris-Le Bourget, 93350 Le Bourget', 48.9614, 2.4376,
    now(), 'Shangri-La — Mrs. Chen', 2, 'first', 16000);
  update public.rides set next_dispatch_at = now() - interval '1 second', dispatch_started_at = now() - interval '6 minutes' where id = r;
  perform private.dispatch_tick();

  -- Riviera : une course en cours et une offre
  r := pg_temp.new_ride(b, 'dashboard', 'Aéroport Nice Côte d''Azur, Terminal 2, 06200 Nice', 43.6584, 7.2159,
    'Place du Casino, 98000 Monaco', 43.7392, 7.4277, now(), 'Mr. Andersson', 2, 'business', 9000, 'SK4461');
  perform pg_temp.accept_as('lorenzo@riviera-prestige.fr', r);
  perform pg_temp.advance_as('lorenzo@riviera-prestige.fr', r, array['DRIVER_EN_ROUTE','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS']::public.ride_status[]);

  perform pg_temp.reset_claims();
end;
$$;

-- -----------------------------------------------------------------------------
-- Option 2 — Centrale à commission : « Centrale Express Paris »
--   Centrale        contact@centrale-express.fr   Rydar!Demo2026
--   Chauffeurs      amine@centrale-express.fr …   Rydar!Driver2026
--   Inscription     /rejoindre/express2026demo
-- Répartition affichée aux chauffeurs, règlements dans tous les états (à régler, en retard →
-- chauffeur bloqué, déclaré, contesté, encaissé, part à verser), 2 candidatures, 1 banni signalé.
-- -----------------------------------------------------------------------------
do $$
begin
  perform pg_temp.seed_user('00000000-0000-4000-a000-000000000005', 'contact@centrale-express.fr', 'Rydar!Demo2026', 'Yacine Rahmani');
end;
$$;

insert into public.organizations (id, name, slug, plan_id, legal_name, siret, email, phone, address, city, postal_code, brand_color,
  created_at, dispatch_model, platform_fee_fixed_cents, join_code, join_enabled)
values ('10000000-0000-4000-a000-00000000000c', 'Centrale Express Paris', 'centrale-express',
  (select id from public.plans where code = 'pro'), 'Centrale Express SAS', '93456789000014', 'contact@centrale-express.fr',
  '+33 1 84 60 77 77', '9 Rue de la Paix', 'Paris', '75002', '#FFB020', now() - interval '45 days',
  'centrale', 500, 'express2026demo', true)
on conflict (id) do nothing;

insert into public.organization_users (organization_id, user_id, role)
values ('10000000-0000-4000-a000-00000000000c', '00000000-0000-4000-a000-000000000005', 'owner')
on conflict do nothing;

insert into public.subscriptions (organization_id, plan_id, status, billing_interval, current_period_start, current_period_end)
select o.id, o.plan_id, 'trialing', 'month', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
from public.organizations o
where o.id = '10000000-0000-4000-a000-00000000000c'
  and not exists (select 1 from public.subscriptions s where s.organization_id = o.id);

update public.organization_settings set
  driver_commission_percent = 20,
  settlement_grace_hours = 24,
  settlement_credit_limit_cents = 6000,
  block_unpaid = true,
  new_driver_max_price_cents = 5000,
  trust_after_rides = 5,
  settlement_methods = '{link,cash,transfer}',
  settlement_link = 'https://revolut.me/centrale-express/{montant}',
  settlement_instructions = 'Indiquez la référence (ex. C1783) dans le commentaire du paiement.',
  default_payment_method = 'cash'
where organization_id = '10000000-0000-4000-a000-00000000000c';

create temp table seed_centrale (
  idx int, first_name text, last_name text, phone text, email text, brand text, model text, color text, plate text,
  category public.vehicle_category, seats int, lat double precision, lng double precision, online boolean, trust text
);
insert into seed_centrale values
  (1, 'Amine', 'Kaci', '+33 7 51 20 30 41', 'amine@centrale-express.fr', 'Toyota', 'C-HR Hybride', 'Blanc', 'GW-214-LA', 'standard', 4, 48.8712, 2.3325, true, 'trusted'),
  (2, 'Bilal', 'Mansouri', '+33 7 52 21 31 42', 'bilal@centrale-express.fr', 'Mercedes-Benz', 'Classe E 220d', 'Noir', 'GX-318-MB', 'business', 4, 48.8538, 2.3690, true, 'trusted'),
  (3, 'Walid', 'Ziani', '+33 7 53 22 32 43', 'walid@centrale-express.fr', 'Kia', 'Niro EV', 'Gris', 'GY-452-WZ', 'green', 4, 48.8795, 2.3560, true, 'new'),
  (4, 'Rachid', 'Oukaci', '+33 7 54 23 33 44', 'rachid@centrale-express.fr', 'Mercedes-Benz', 'Classe V 250', 'Noir', 'GZ-587-RO', 'van', 7, 48.8420, 2.3200, false, 'trusted'),
  (5, 'Moussa', 'Keita', '+33 7 55 24 34 45', 'moussa@centrale-express.fr', 'Skoda', 'Octavia Combi', 'Noir', 'HA-619-MK', 'standard', 4, 48.8418, 2.3215, true, 'trusted'),
  (6, 'Kévin', 'Tran', '+33 7 56 25 35 46', 'kevin@centrale-express.fr', 'Tesla', 'Model Y', 'Noir', 'HB-733-KT', 'green', 4, 48.8905, 2.2400, true, 'new'),
  (7, 'Nordine', 'Belaïd', '+33 7 57 26 36 47', 'nordine@centrale-express.fr', 'BMW', 'Série 5 530e', 'Gris', 'HC-845-NB', 'business', 4, 48.8690, 2.3080, true, 'trusted'),
  (8, 'Farès', 'Djebbar', '+33 7 58 27 37 48', 'fares@centrale-express.fr', 'Peugeot', '508 SW', 'Noir', 'HD-951-FD', 'standard', 4, 48.8600, 2.3500, false, 'trusted');

do $$
declare
  c constant uuid := '10000000-0000-4000-a000-00000000000c';
  f record;
  v_user uuid;
  v_vehicle uuid;
  v_driver uuid;
begin
  if exists (select 1 from public.drivers where organization_id = c) then
    return;
  end if;
  for f in select * from seed_centrale order by idx loop
    v_user := pg_temp.seed_user(gen_random_uuid(), f.email, 'Rydar!Driver2026', f.first_name || ' ' || f.last_name);
    insert into public.vehicles (organization_id, brand, model, color, plate, category, seats, luggage_capacity, year)
    values (c, f.brand, f.model, f.color, f.plate, f.category, f.seats, case when f.category = 'van' then 7 else 3 end, 2021 + (f.idx % 4))
    returning id into v_vehicle;
    insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence, vehicle_id,
      vtc_card_number, online_since, trust_level, joined_via, created_at)
    values (c, v_user, f.first_name, f.last_name, f.phone, f.email, 'active',
      case when f.online then 'available' else 'offline' end::public.driver_presence, v_vehicle,
      'EVTC-075-' || (41000 + f.idx * 211)::text, case when f.online then now() - make_interval(mins => 15 + f.idx * 9) end,
      f.trust, case when f.idx in (3, 6) then 'join_link' else 'dashboard' end, now() - make_interval(days => 40 - f.idx * 3))
    returning id into v_driver;
    insert into public.driver_locations (driver_id, organization_id, lat, lng, heading, speed_mps, accuracy_m, battery_level, recorded_at, updated_at)
    values (v_driver, c, f.lat, f.lng, (f.idx * 53) % 360, case when f.online then 0 end, 9, 0.5 + (f.idx % 5) / 10.0,
      case when f.online then now() else now() - interval '5 hours' end,
      case when f.online then now() else now() - interval '5 hours' end);
    insert into public.driver_documents (organization_id, driver_id, type, label, number, expires_at, status) values
      (c, v_driver, 'vtc_card', 'Carte VTC', 'EVTC-075-' || (41000 + f.idx * 211)::text, current_date + (300 + f.idx * 20), 'valid'),
      (c, v_driver, 'driving_license', 'Permis B', 'B-' || (310000 + f.idx), current_date + 2500, 'valid');
  end loop;

  -- Candidatures reçues par le lien d'inscription (en attente de validation)
  v_user := pg_temp.seed_user(gen_random_uuid(), 'idriss.camara@gmail.com', 'Rydar!Driver2026', 'Idriss Camara');
  insert into public.vehicles (organization_id, brand, model, color, plate, category, seats)
  values (c, 'Toyota', 'Prius+', 'Gris', 'HE-102-IC', 'standard', 7) returning id into v_vehicle;
  insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, vtc_card_number, status, presence,
    vehicle_id, trust_level, joined_via, application_status, application_message, applied_at)
  values (c, v_user, 'Idriss', 'Camara', '+33 6 41 52 63 74', 'idriss.camara@gmail.com', 'EVTC-093-55120', 'inactive', 'offline',
    v_vehicle, 'new', 'join_link', 'pending', 'Chauffeur VTC depuis 4 ans, dispo le soir et le week-end (groupe WhatsApp Paris Nord).',
    now() - interval '3 hours');
  insert into public.driver_documents (organization_id, driver_id, type, label, number, expires_at, status, source)
  select c, d.id, 'vtc_card', 'Carte VTC', 'EVTC-093-55120', current_date + 700, 'pending', 'driver'
  from public.drivers d where d.user_id = v_user;

  v_user := pg_temp.seed_user(gen_random_uuid(), 'jordan.lefort@outlook.fr', 'Rydar!Driver2026', 'Jordan Lefort');
  insert into public.vehicles (organization_id, brand, model, color, plate, category, seats)
  values (c, 'Hyundai', 'Ioniq 5', 'Bleu', 'HF-208-JL', 'green', 4) returning id into v_vehicle;
  insert into public.drivers (organization_id, user_id, first_name, last_name, phone, email, status, presence,
    vehicle_id, trust_level, joined_via, application_status, application_message, applied_at)
  values (c, v_user, 'Jordan', 'Lefort', '+33 6 52 63 74 85', 'jordan.lefort@outlook.fr', 'inactive', 'offline',
    v_vehicle, 'new', 'join_link', 'pending', 'Ajouté par Karim du groupe Telegram.', now() - interval '26 minutes');
end;
$$;

-- Historique 12 jours (import direct) + règlements dans tous les états
create or replace function pg_temp.centrale_ride(
  p_email text, p_at timestamptz, p_from int, p_to int, p_price int, p_commission int,
  p_method public.payment_method, p_status text, p_customer text)
returns uuid
language plpgsql
as $$
declare
  c constant uuid := '10000000-0000-4000-a000-00000000000c';
  v_pois constant jsonb := '[
    {"a":"Gare Saint-Lazare, 13 Rue d''Amsterdam, 75008 Paris","lat":48.8763,"lng":2.3253},
    {"a":"Aéroport Paris-Charles de Gaulle, Terminal 2F, 95700 Roissy-en-France","lat":49.0034,"lng":2.5700},
    {"a":"Aéroport de Paris-Orly, Terminal 1, 94390 Orly","lat":48.7262,"lng":2.3652},
    {"a":"Place de la République, 75003 Paris","lat":48.8676,"lng":2.3631},
    {"a":"Gare de Lyon, Place Louis-Armand, 75012 Paris","lat":48.8443,"lng":2.3743},
    {"a":"Accor Arena, 8 Boulevard de Bercy, 75012 Paris","lat":48.8386,"lng":2.3785},
    {"a":"Stade de France, 93200 Saint-Denis","lat":48.9245,"lng":2.3601},
    {"a":"La Défense, Parvis de la Défense, 92400 Courbevoie","lat":48.8924,"lng":2.2360},
    {"a":"Montmartre, Place du Tertre, 75018 Paris","lat":48.8865,"lng":2.3408},
    {"a":"Gare Montparnasse, 17 Boulevard de Vaugirard, 75015 Paris","lat":48.8414,"lng":2.3209}
  ]';
  d record;
  v_p jsonb := v_pois -> p_from;
  v_d jsonb := v_pois -> p_to;
  v_dist float;
  v_done timestamptz;
  v_ride uuid;
  v_number bigint;
  v_split record;
  v_direction text := case when p_method in ('cash', 'card') then 'driver_owes' else 'centrale_owes' end;
begin
  select x.id, x.first_name, x.last_name, x.number, x.vehicle_id, v.category into d
  from public.drivers x join public.vehicles v on v.id = x.vehicle_id
  where x.organization_id = c and x.email = p_email;
  v_dist := 1.35 * 111.32 * sqrt(power((v_p ->> 'lat')::float - (v_d ->> 'lat')::float, 2)
            + power(((v_p ->> 'lng')::float - (v_d ->> 'lng')::float) * cos(radians((v_p ->> 'lat')::float)), 2));
  v_done := p_at + make_interval(mins => 12 + (v_dist * 1.6)::int);

  insert into public.rides (organization_id, type, status, source, dispatch_mode, pickup_address, pickup_lat, pickup_lng,
    dropoff_address, dropoff_lat, dropoff_lng, pickup_at, customer_name, customer_phone, passengers, vehicle_category,
    price_cents, commission_cents, payment_method, driver_id, vehicle_id, dispatch_wave, dispatch_radius_m,
    dispatch_started_at, offered_at, accepted_at, driver_en_route_at, driver_arrived_at, passenger_onboard_at, started_at,
    completed_at, created_at, estimated_distance_m, estimated_duration_s)
  values (c, 'instant', 'COMPLETED', 'booking_site', 'geo', v_p ->> 'a', (v_p ->> 'lat')::float, (v_p ->> 'lng')::float,
    v_d ->> 'a', (v_d ->> 'lat')::float, (v_d ->> 'lng')::float, p_at, p_customer, '+33 6 12 98 76 54', 1, d.category,
    p_price, p_commission, p_method, d.id, d.vehicle_id, 1, 4000,
    p_at - interval '6 minutes', p_at - interval '6 minutes', p_at - interval '5 minutes', p_at - interval '5 minutes', p_at,
    p_at + interval '3 minutes', p_at + interval '3 minutes', v_done, p_at - interval '8 minutes',
    (v_dist * 1000)::int, (v_dist * 100)::int)
  returning id, number into v_ride, v_number;

  select r.commission_cents, r.platform_fee_cents, r.driver_payout_cents into v_split from public.rides r where r.id = v_ride;
  insert into public.ride_settlements (organization_id, ride_id, driver_id, driver_label, direction, amount_cents, price_cents,
    commission_cents, platform_fee_cents, driver_payout_cents, currency, payment_method, reference, status, due_at,
    declared_at, declared_method, settled_at, settled_method, note, reminders_sent, last_reminded_at, created_at)
  values (c, v_ride, d.id, format('%s %s (#%s)', d.first_name, d.last_name, d.number), v_direction,
    case when v_direction = 'driver_owes' then v_split.commission_cents + v_split.platform_fee_cents else v_split.driver_payout_cents end,
    p_price, v_split.commission_cents, v_split.platform_fee_cents, v_split.driver_payout_cents, 'EUR', p_method,
    'C' || v_number::text, p_status,
    v_done + case when v_direction = 'driver_owes' then interval '24 hours' else interval '7 days' end,
    case when p_status in ('declared', 'disputed') then v_done + interval '3 hours' end,
    case when p_status in ('declared', 'disputed') then 'link' end,
    case when p_status in ('paid', 'waived') then v_done + interval '20 hours' end,
    case when p_status = 'paid' then (array['link', 'cash', 'transfer'])[1 + (v_number % 3)::int] end,
    case p_status when 'disputed' then 'Rien reçu sur le compte Revolut' when 'waived' then 'Client parti sans payer' end,
    case when p_status = 'due' and v_done < now() - interval '24 hours' then 1 else 0 end,
    case when p_status = 'due' and v_done < now() - interval '24 hours' then now() - interval '2 hours' end,
    v_done);
  return v_ride;
end;
$$;

do $$
declare
  c constant uuid := '10000000-0000-4000-a000-00000000000c';
  v_trusted text[] := array['amine@centrale-express.fr', 'bilal@centrale-express.fr', 'rachid@centrale-express.fr',
                            'moussa@centrale-express.fr', 'nordine@centrale-express.fr', 'fares@centrale-express.fr'];
  v_customers text[] := array['M. Ryan Morel', 'Mme Lina Haddad', 'M. Omar Diallo', 'Mme Eva Martin', 'M. Tom Nguyen',
    'Mme Sarah Benoit', 'M. Adam Perret', 'Mme Maya Colin'];
  v_day timestamptz;
  v_from int;
  v_to int;
  v_price int;
  i int;
  day_ago int;
begin
  if exists (select 1 from public.rides where organization_id = c) then
    return;
  end if;
  perform set_config('rydar.bypass_ride_rules', 'on', false);

  -- J-12 → J-3 : courses réglées (commission encaissée / part versée)
  for day_ago in reverse 12..3 loop
    v_day := ((now() at time zone 'Europe/Paris')::date - day_ago)::timestamp at time zone 'Europe/Paris';
    for i in 1..(4 + floor(random() * 4)::int) loop
      v_from := floor(random() * 10)::int;
      v_to := (v_from + 1 + floor(random() * 8)::int) % 10;
      v_price := 2500 + (floor(random() * 12)::int * 500);
      perform pg_temp.centrale_ride(v_trusted[1 + floor(random() * array_length(v_trusted, 1))::int],
        v_day + make_interval(hours => 7 + floor(random() * 15)::int, mins => floor(random() * 60)::int),
        v_from, v_to, v_price, case when random() < 0.25 then (round(v_price * 0.24 / 100.0) * 100)::int end,
        case when random() < 0.8 then 'cash' else 'online' end::public.payment_method, 'paid',
        v_customers[1 + floor(random() * array_length(v_customers, 1))::int]);
    end loop;
  end loop;
  -- Nouveaux chauffeurs : quelques courses réglées (sous le plafond de 50 €)
  perform pg_temp.centrale_ride('walid@centrale-express.fr', now() - interval '5 days 3 hours', 3, 8, 3200, null, 'cash', 'paid', 'M. Tom Nguyen');
  perform pg_temp.centrale_ride('kevin@centrale-express.fr', now() - interval '4 days 5 hours', 7, 0, 4500, null, 'cash', 'paid', 'Mme Maya Colin');

  -- J-2 / J-1 : tous les états de règlement
  v_day := ((now() at time zone 'Europe/Paris')::date - 2)::timestamp at time zone 'Europe/Paris';
  perform pg_temp.centrale_ride('moussa@centrale-express.fr', v_day + interval '9 hours 10 minutes', 9, 2, 6200, null, 'cash', 'due', 'M. Omar Diallo');
  perform pg_temp.centrale_ride('moussa@centrale-express.fr', v_day + interval '18 hours 40 minutes', 0, 7, 3800, null, 'cash', 'due', 'Mme Sarah Benoit');
  perform pg_temp.centrale_ride('kevin@centrale-express.fr', v_day + interval '21 hours 15 minutes', 4, 5, 2500, null, 'cash', 'waived', 'M. Ryan Morel');
  v_day := ((now() at time zone 'Europe/Paris')::date - 1)::timestamp at time zone 'Europe/Paris';
  perform pg_temp.centrale_ride('walid@centrale-express.fr', v_day + interval '8 hours 30 minutes', 3, 4, 3000, null, 'cash', 'declared', 'Mme Eva Martin');
  perform pg_temp.centrale_ride('bilal@centrale-express.fr', v_day + interval '11 hours', 4, 1, 7900, 1900, 'cash', 'disputed', 'M. Adam Perret');
  perform pg_temp.centrale_ride('rachid@centrale-express.fr', v_day + interval '14 hours 20 minutes', 1, 0, 8900, null, 'online', 'due', 'Groupe Aurel — Mme Rossi');
  perform pg_temp.centrale_ride('nordine@centrale-express.fr', v_day + interval '16 hours', 7, 3, 4600, null, 'cash', 'paid', 'Mme Lina Haddad');
  perform pg_temp.centrale_ride('amine@centrale-express.fr', v_day + interval '20 hours 45 minutes', 5, 9, 5900, 1400, 'cash', 'due', 'Mme Maya Colin');

  perform set_config('rydar.bypass_ride_rules', 'off', false);
end;
$$;

-- Aujourd'hui : moteur réel (course terminée → commission due ; offre « Vous gagnez … » en cours ; banni signalé)
do $$
declare
  c constant uuid := '10000000-0000-4000-a000-00000000000c';
  r uuid;
begin
  if exists (select 1 from public.rides where organization_id = c and created_at > now() - interval '1 hour' and source <> 'booking_site') then
    return;
  end if;

  -- Course terminée par Amine (espèces) : commission de 19 € à régler
  perform pg_temp.reset_claims();
  insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
    pickup_at, customer_name, customer_phone, passengers, vehicle_category, price_cents, commission_cents, payment_method,
    estimated_distance_m, estimated_duration_s)
  values (c, 'dashboard', 'Opéra Garnier, Place de l''Opéra, 75009 Paris', 48.8720, 2.3316,
    'Gare de Lyon, Place Louis-Armand, 75012 Paris', 48.8443, 2.3743, now(), 'Mme Lina Haddad', '+33 6 71 42 98 10', 1,
    'standard', 5900, 1400, 'cash', 4300, 960)
  returning id into r;
  perform pg_temp.accept_as('amine@centrale-express.fr', r);
  perform pg_temp.advance_as('amine@centrale-express.fr', r,
    array['DRIVER_EN_ROUTE','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS','COMPLETED']::public.ride_status[]);

  -- Course en cours : Nordine
  r := pg_temp.new_ride(c, 'booking_site', '12 Avenue des Champs-Élysées, 75008 Paris', 48.8698, 2.3075,
    'Aéroport Paris-Charles de Gaulle, Terminal 2E, 95700 Roissy-en-France', 49.0047, 2.5710, now(), 'M. Adam Perret', 2, 'business', 6900);
  perform pg_temp.accept_as('nordine@centrale-express.fr', r);
  perform pg_temp.advance_as('nordine@centrale-express.fr', r,
    array['DRIVER_EN_ROUTE','DRIVER_ARRIVED','PASSENGER_ONBOARD','IN_PROGRESS']::public.ride_status[]);

  -- Offre en cours près de l'Opéra : 59 € dont 14 € de commission et 5 € de frais → « Vous gagnez 40 € »
  insert into public.rides (organization_id, source, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng,
    pickup_at, customer_name, customer_phone, passengers, vehicle_category, price_cents, commission_cents, payment_method,
    estimated_distance_m, estimated_duration_s)
  values (c, 'booking_site', 'Place de l''Opéra, 75009 Paris', 48.8710, 2.3320,
    'Aéroport de Paris-Orly, Terminal 1, 94390 Orly', 48.7262, 2.3652, now(), 'Mme Eva Martin', '+33 6 18 27 36 45', 1,
    'standard', 5900, 1400, 'cash', 21400, 1860)
  returning id into r;

  -- Chauffeur banni pour commissions impayées + signalement au super admin
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-a000-000000000005', 'role', 'authenticated')::text, false);
  perform public.ban_driver((select id from public.drivers where email = 'fares@centrale-express.fr'),
    'Encaisse les courses en espèces sans jamais régler la commission (5 courses)', 'unpaid', true, false);
  perform pg_temp.reset_claims();
end;
$$;

select
  (select count(*) from public.organizations) as organizations,
  (select count(*) from public.drivers) as drivers,
  (select count(*) from public.rides) as rides,
  (select count(*) from public.ride_events) as events;
