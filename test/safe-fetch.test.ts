import assert from "node:assert/strict";
import { test } from "node:test";
import { FetchRefused, isPrivateIPv4, isPrivateIPv6, refuseUrl, safeFetch } from "../worker/src/safe-fetch.ts";

test("only http(s) to public hosts", () => {
  assert.equal(refuseUrl("https://api.weather.gov/points"), null);
  assert.equal(refuseUrl("ftp://example.com"), "Only http and https addresses can be fetched");
  assert.equal(refuseUrl("file:///etc/passwd"), "Only http and https addresses can be fetched");
  assert.equal(refuseUrl("http://localhost:8787/api/files"), "Local names can't be fetched");
  assert.equal(refuseUrl("http://printer.local/"), "Local names can't be fetched");
  assert.equal(refuseUrl("http://intranet/"), "Local names can't be fetched");
  assert.equal(refuseUrl("http://169.254.169.254/latest/meta-data"), "Private and local addresses can't be fetched");
  assert.equal(refuseUrl("http://[::1]/"), "Private and local addresses can't be fetched");
  assert.equal(refuseUrl("https://user:pass@example.com/"), "Addresses with a user name or password can't be fetched");
  assert.equal(refuseUrl("not a url"), "That isn't a URL");
});

test("private, loopback, link-local and reserved addresses are recognised, v4 and v6", () => {
  for (const ip of ["10.0.0.1", "127.0.0.1", "172.20.1.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1"]) assert.ok(!isPrivateIPv4(ip), ip);
  for (const ip of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateIPv6(ip), ip);
  for (const ip of ["2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isPrivateIPv6(ip), ip);
});

const publicDns = async () => ["93.184.216.34"];

test("a host that resolves to a private address is refused, and so is a redirect to one", async () => {
  const fetched: string[] = [];
  const fetcher = (async (url: string) => {
    fetched.push(url);
    if (url === "https://good.example/start") return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
    return new Response("secret");
  }) as typeof fetch;
  await assert.rejects(safeFetch("https://rebind.example/", { fetcher, resolve: async () => ["10.1.2.3"] }), new FetchRefused("rebind.example resolves to a private address"));
  await assert.rejects(safeFetch("https://good.example/start", { fetcher, resolve: publicDns }), new FetchRefused("Private and local addresses can't be fetched"));
  assert.deepEqual(fetched, ["https://good.example/start"], "the private address was never asked");
});

test("redirects are followed to a limit, bodies are cut off at a size, and credentials never go out", async () => {
  let hops = 0;
  const seen: Array<Record<string, string>> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    if (url.includes("/loop")) return new Response(null, { status: 301, headers: { location: `/loop?${++hops}` } });
    if (url.endsWith("/big")) return new Response("x".repeat(100));
    return new Response(null, { status: 302, headers: { location: "https://other.example/big" } });
  }) as typeof fetch;
  await assert.rejects(safeFetch("https://a.example/loop", { fetcher, resolve: publicDns }), new FetchRefused("Too many redirects"));
  const res = await safeFetch("https://a.example/start", { fetcher, resolve: publicDns, maxBytes: 10, headers: { Cookie: "session=1", Authorization: "Bearer x", Accept: "text/html" } });
  assert.deepEqual([res.url, res.body, res.truncated], ["https://other.example/big", "xxxxxxxxxx", true]);
  assert.deepEqual(seen.at(-1), { Accept: "text/html" });
});

test("a fetch that takes too long is stopped", async () => {
  const fetcher = ((_url: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as typeof fetch;
  // AbortSignal.timeout's timer doesn't keep Node running by itself.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(safeFetch("https://slow.example/", { fetcher, resolve: publicDns, timeoutMs: 20 }), new FetchRefused("It took too long"));
  clearTimeout(keepAlive);
});
