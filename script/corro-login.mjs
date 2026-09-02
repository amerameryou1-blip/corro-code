#!/usr/bin/env node
/* Corro Code CLI login helper.
 * Usage: node script/corro-login.mjs you@example.com 'password' [--save]
 * Prints the JWT for `provider.corro.options.apiKey`; with --save writes
 * ~/.config/corro/auth.json so `corro` can pick it up. */
import { writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPABASE = "https://orojnlnhwnsmevkxbpte.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yb2pubG5od25zbWV2a3hicHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTA0MzIsImV4cCI6MjEwMzg2NjQzMn0.66jopRYujYCSPEIBQ71-BtCjaqVZaOtrSY16n_CDZxQ";

const [email, password] = process.argv.slice(2);
const save = process.argv.includes("--save");
if (!email || !password) {
  console.error("usage: node script/corro-login.mjs <email> <password> [--save]");
  process.exit(1);
}
const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
const body = await res.json();
if (!res.ok || !body.access_token) {
  console.error("login failed:", body.error_description || body.msg || res.status);
  process.exit(1);
}
console.log(body.access_token);
if (save) {
  const dir = join(homedir(), ".config", "corro");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "auth.json"), JSON.stringify({ jwt: body.access_token, refresh: body.refresh_token, email }, null, 2));
  console.error(`saved → ${join(dir, "auth.json")}`);
}
