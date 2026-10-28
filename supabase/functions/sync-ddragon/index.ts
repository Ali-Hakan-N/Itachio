// Supabase Edge Function: sync-ddragon
// Fetches the current patch and champion list from Riot Data Dragon and
// writes them to the `champions` and `app_meta` tables.
//
// Call: POST /functions/v1/sync-ddragon  (header: x-cron-secret: <CRON_SECRET>)
// Schedule: supabase/cron.sql

import { createClient } from "npm:@supabase/supabase-js@2";

const DDRAGON = "https://ddragon.leagueoflegends.com";

type DdChampion = {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  image: { full: string };
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  try {
    const versions: string[] = await (await fetch(`${DDRAGON}/api/versions.json`)).json();
    const patch = versions[0];

    const res = await fetch(`${DDRAGON}/cdn/${patch}/data/en_US/champion.json`);
    if (!res.ok) throw new Error(`champion.json ${res.status}`);
    const data: { data: Record<string, DdChampion> } = await res.json();

    const now = new Date().toISOString();
    const rows = Object.values(data.data).map((c) => ({
      id: Number(c.key),
      slug: c.id,
      name: c.name,
      title: c.title,
      tags: c.tags,
      image: c.image.full,
      patch,
      updated_at: now,
    }));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { error: e1 } = await supabase.from("champions").upsert(rows, { onConflict: "id" });
    if (e1) throw e1;

    const { error: e2 } = await supabase
      .from("app_meta")
      .upsert({ key: "current_patch", value: patch, updated_at: now }, { onConflict: "key" });
    if (e2) throw e2;

    return json({ ok: true, patch, champions: rows.length });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String((err as Error)?.message ?? err) }, 500);
  }
});
