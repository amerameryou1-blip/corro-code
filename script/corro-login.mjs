#!/usr/bin/env node
/** Corro Code sign-in: exchanges email+password for a Supabase JWT and prints
 *  it (or stores it with --save). Zero deps: node script/corro-login.mjs <email> <password> [--save] */
const SUPABASE_URL = "https://orojnlnhwnsmevkxbpte.supabase.co";
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yb2pubG5od25zbWV2a3hicHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTA0MzIsImV4cCI6MjEwMzg2NjQzMn0.66jopRYujYCSPEIBQ71-BtCjaqVZaOtrSY16n_CDZxQ";
const [email, password, save] = process.argv.slice(2);
if (!email || !password) { console.error("usage: corro-login.mjs <email> <password> [--save]"); process.exit(2); }
const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const body = await r.json();
if (!r.ok) { console.error("login failed:", body.error_description || body.msg || body.error); process.exit(1); }
if (save === "--save") {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const dir = `${homedir()}/.config/corro`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/auth.json`, JSON.stringify({ jwt: body.access_token, email }, null, 2));
  console.error(`saved to ${dir}/auth.json`);
  console.log(body.access_token);
} else {
  console.log(body.access_token);
}
