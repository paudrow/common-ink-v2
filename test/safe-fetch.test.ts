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

test("an IPv6 address that carries a private IPv4 one is private, however it's written", () => {
  for (const url of [
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data",
    "http://[::127.0.0.1]/",
    "http://[::ffff:0:10.0.0.1]/",
    "http://[64:ff9b::169.254.169.254]/",
    "http://[2002:a00:1::]/",
    "http://[2001:0:4136:e378::1]/",
    "http://[fec0::1]/",
    "http://[100::1]/",
  ]) {
    assert.equal(refuseUrl(url), "Private and local addresses can't be fetched", url);
  }
  for (const ip of ["::ffff:7f00:1", "64:ff9b::a00:1", "2002:c0a8:101::1", "::a9fe:a9fe", "2001:db8::1", "not:an:address"]) assert.ok(isPrivateIPv6(ip), ip);
  for (const ip of ["2606:4700:4700::1111", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1", "2a00:1450:4001:830::200e"]) assert.ok(!isPrivateIPv6(ip), ip);
});

test("a local name with a trailing dot is still a local name", () => {
  assert.equal(refuseUrl("http://localhost./"), "Local names can't be fetched");
  assert.equal(refuseUrl("http://printer.local./"), "Local names can't be fetched");
});

test("a host whose AAAA record maps to a private IPv4 address is refused", async () => {
  const fetcher = (async () => new Response("secret")) as typeof fetch;
  await assert.rejects(safeFetch("https://mapped.example/", { fetcher, resolve: async () => ["::ffff:a9fe:a9fe"] }), new FetchRefused("mapped.example resolves to a private address"));
});

test("a redirect to another site doesn't take the caller's own headers with it", async () => {
  const seen: Array<[string, Record<string, string>]> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push([url, init.headers as Record<string, string>]);
    if (url === "https://api.example/one") return new Response(null, { status: 302, headers: { location: "/two" } });
    if (url === "https://api.example/two") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/three" } });
    return new Response("ok");
  }) as typeof fetch;
  await safeFetch("https://api.example/one", { fetcher, resolve: publicDns, headers: { "X-Api-Key": "k-123", Accept: "application/json" } });
  assert.deepEqual(seen, [
    ["https://api.example/one", { "X-Api-Key": "k-123", Accept: "application/json" }],
    ["https://api.example/two", { "X-Api-Key": "k-123", Accept: "application/json" }],
    ["https://elsewhere.example/three", { Accept: "application/json" }],
  ]);
});
