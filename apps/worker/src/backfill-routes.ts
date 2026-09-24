/**
 * Calcule le tracé routier des courses qui n'en ont pas (après la migration
 * 001400, ou si le routage était indisponible à la création).
 *
 *   OSRM_URL=... DATABASE_URL=... pnpm --filter @rydar/worker backfill-routes [--days 30]
 */
import pg from "pg";
import { config, log } from "./config";
import { osrmRoute } from "./routing";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 30;
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });

async function main() {
  const { rows } = await pool.query(
    `select id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng from rides
      where (route_polyline is null or route_provider = 'estimate')
        and dropoff_lat is not null and dropoff_lng is not null
        and (pickup_at > now() - make_interval(days => $1) or status not in ('COMPLETED','CANCELLED','NO_DRIVER_FOUND'))
      order by pickup_at desc`,
    [days],
  );
  let ok = 0;
  for (const r of rows) {
    const route = await osrmRoute({ lat: r.pickup_lat, lng: r.pickup_lng }, { lat: r.dropoff_lat, lng: r.dropoff_lng });
    if (route.approximate) continue;
    // Connexion directe (rôle propriétaire) : colonnes d'itinéraire uniquement
    await pool.query(
      "update rides set route_polyline = $2, route_provider = 'osrm', estimated_distance_m = $3, estimated_duration_s = $4 where id = $1",
      [r.id, route.polyline, route.distanceM, route.durationS],
    );
    ok++;
  }
  log("info", "tracés calculés", { candidates: rows.length, updated: ok });
  await pool.end();
}

void main();
