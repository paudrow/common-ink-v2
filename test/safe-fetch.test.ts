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

test("only 192.0.0.0/24 and 192.0.2.0/24 are reserved in 192.0, so WordPress.com's addresses can be fetched", () => {
  for (const ip of ["192.0.0.8", "192.0.2.1"]) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ["192.0.78.9", "192.0.66.220"]) assert.ok(!isPrivateIPv4(ip), ip);
});

test("a body that stops coming is stopped too, as taking too long", async () => {
  const fetcher = ((_url: string, init: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("partial"));
            init.signal!.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
          },
        }),
      ),
    )) as typeof fetch;
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(safeFetch("https://slow.example/", { fetcher, resolve: publicDns, timeoutMs: 20 }), new FetchRefused("It took too long"));
  clearTimeout(keepAlive);
});

test("each redirect's host must be one the caller allows, and a body isn't sent on to another site", async () => {
  const fetched: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    fetched.push(`${init.method} ${url} ${init.body ?? ""}`);
    if (url === "https://api.example/go") return new Response(null, { status: 302, headers: { location: "https://undeclared.example/" } });
    if (url === "https://api.example/post") return new Response(null, { status: 307, headers: { location: "https://other.example/inbox" } });
    if (url === "https://api.example/here") return new Response(null, { status: 307, headers: { location: "/there" } });
    return new Response("ok");
  }) as typeof fetch;
  const allowHost = (host: string) => host === "api.example" || host === "other.example";
  await assert.rejects(safeFetch("https://api.example/go", { fetcher, resolve: publicDns, allowHost }), new FetchRefused("It was sent on to undeclared.example, which it may not reach"));
  await assert.rejects(safeFetch("https://api.example/post", { fetcher, resolve: publicDns, allowHost, method: "POST", body: "secret" }), new FetchRefused("It was sent on to other.example with its body, which only a request to the same site may be"));
  const same = await safeFetch("https://api.example/here", { fetcher, resolve: publicDns, allowHost, method: "POST", body: "note" });
  assert.equal(same.url, "https://api.example/there");
  assert.deepEqual(fetched, ["GET https://api.example/go ", "POST https://api.example/post secret", "POST https://api.example/here note", "POST https://api.example/there note"]);
});

test("the documentation ranges and the old 6to4 relay are refused too", () => {
  for (const ip of ["198.51.100.7", "203.0.113.9", "192.88.99.1"]) assert.ok(isPrivateIPv4(ip), ip);
  for (const ip of ["198.51.101.7", "203.0.114.9", "192.88.100.1"]) assert.ok(!isPrivateIPv4(ip), ip);
});

test("a redirect to something that isn't http(s) says so, before asking whether its host is allowed", async () => {
  const fetcher = (async () => new Response(null, { status: 302, headers: { location: "ftp://files.example/x" } })) as typeof fetch;
  await assert.rejects(safeFetch("https://api.example/go", { fetcher, resolve: publicDns, allowHost: (h) => h === "api.example" }), new FetchRefused("Only http and https addresses can be fetched"));
});
