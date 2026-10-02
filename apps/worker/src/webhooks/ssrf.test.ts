import { describe, expect, it } from "vitest";
import { classifyAddress, pinnedLookup, resolveWebhookTarget, webhookAllowPrivate, WebhookUrlError, type Resolver } from "./ssrf";

describe("webhooks — classement des adresses (garde SSRF)", () => {
  it.each([
    // IPv4 publiques (bords de plages compris)
    "1.1.1.1",
    "8.8.8.8",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
    "76.76.21.21",
    // IPv6 publiques
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4007:80f::200e",
    "2a01:cb00::1",
    // IPv4 publique sous forme IPv6
    "::ffff:8.8.8.8",
    "::ffff:808:808",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("%s : publique", (ip) => {
    expect(classifyAddress(ip)).toBeNull();
  });

  it.each([
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this-network"],
    ["0.255.255.255", "this-network"],
    ["10.0.0.0", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.0", "cgnat"],
    ["100.127.255.255", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "link-local"], // métadonnées des fournisseurs cloud
    ["172.16.0.0", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["192.0.0.170", "reserved"],
    ["192.0.2.1", "reserved"],
    ["198.18.0.1", "reserved"],
    ["198.19.255.255", "reserved"],
    ["198.51.100.7", "reserved"],
    ["203.0.113.9", "reserved"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    // IPv6
    ["::", "unspecified"],
    ["::0", "unspecified"],
    ["0:0:0:0:0:0:0:0", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["[::1]", "loopback"],
    ["fe80::1", "link-local"],
    ["fe80::1%eth0", "link-local"],
    ["febf:ffff::1", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd12:3456:789a::1", "unique-local"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "unique-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["ff05::1:3", "multicast"],
    ["2001:db8::1", "reserved"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "reserved"], // Teredo
    ["3fff::1", "reserved"],
    ["100::1", "reserved"],
    ["64:ff9b:1::1", "reserved"],
    ["::127.0.0.1", "reserved"], // compatible IPv4 (obsolète)
    ["::a00:1", "reserved"],
    // IPv4 internes sous forme IPv6 (mappée, traduite, NAT64, 6to4)
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "loopback"],
    ["::FFFF:10.1.2.3", "private"],
    ["::ffff:a01:203", "private"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:100.64.0.1", "cgnat"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:192.168.1.1", "private"],
    ["::ffff:224.0.0.1", "multicast"],
    ["::ffff:0:10.0.0.1", "private"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::a00:1", "private"],
    ["2002:7f00:1::", "loopback"],
    ["2002:c0a8:101::1", "private"],
    ["2002:a9fe:a9fe::1", "link-local"],
  ])("%s : %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it.each(["", "localhost", "1.2.3", "256.1.1.1", "1.2.3.4.5", "::g", "1::2::3", "01.2.3.4x", "example.com"])("%s : illisible (refusée)", (ip) => {
    expect(classifyAddress(ip)).toBe("invalid");
  });
});

/** Résolveur factice : nom → adresses (aucune requête DNS réelle). */
function fakeResolver(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (hostname: string) => {
    calls.push(hostname);
    const list = table[hostname];
    if (!list) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const refused = async (p: Promise<unknown>, pattern: RegExp) => {
  const error = await p.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(WebhookUrlError);
  expect((error as Error).message).toMatch(pattern);
  // Jamais d'adresse IP dans le message (enregistré dans last_error, lu par la centrale)
  expect((error as Error).message).not.toMatch(/\d+\.\d+\.\d+\.\d+|[0-9a-f]*:[0-9a-f]*:/i);
  return error as WebhookUrlError;
};

describe("webhooks — validation de l'URL et résolution", () => {
  const resolve = fakeResolver({
    "hooks.example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    "evil.example.com": ["93.184.215.14", "10.0.0.5"],
    "meta.example.com": ["169.254.169.254"],
    "v6evil.example.com": ["::ffff:127.0.0.1"],
    "internal": ["172.18.0.3"],
    "empty.example.com": [],
  });
  const strict = { allowPrivate: false, resolve };

  it("https public : toutes les adresses gardées (connexion épinglée sur elles), port par défaut 443", async () => {
    const t = await resolveWebhookTarget("https://hooks.example.com/rydar?k=1", strict);
    expect(t.hostname).toBe("hooks.example.com");
    expect(t.port).toBe(443);
    expect(t.addresses).toEqual([
      { address: "93.184.215.14", family: 4 },
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
    ]);
    expect((await resolveWebhookTarget("https://hooks.example.com:8443/x", strict)).port).toBe(8443);
    // IP publique littérale : aucune résolution
    const before = resolve.calls.length;
    const ip = await resolveWebhookTarget("https://[2606:4700:4700::1111]/x", strict);
    expect(ip).toMatchObject({ hostname: "2606:4700:4700::1111", addresses: [{ address: "2606:4700:4700::1111", family: 6 }] });
    expect(resolve.calls.length).toBe(before);
  });

  it("une seule adresse interne parmi celles du nom : URL refusée", async () => {
    await refused(resolveWebhookTarget("https://evil.example.com/", strict), /Adresse refusée : réseau privé/);
    await refused(resolveWebhookTarget("https://meta.example.com/", strict), /lien local/);
    await refused(resolveWebhookTarget("https://v6evil.example.com/", strict), /boucle locale/);
    await refused(resolveWebhookTarget("https://internal/hook", strict), /réseau privé/);
  });

  it("IP interne littérale (toutes écritures), localhost, http://, identifiants : refusés", async () => {
    for (const url of [
      "https://127.0.0.1/",
      "https://127.1/",
      "https://2130706433/",
      "https://0x7f.0.0.1/",
      "https://0/",
      "https://10.0.0.1:8443/hook",
      "https://[::1]/",
      "https://[::ffff:127.0.0.1]/",
      "https://[::ffff:a9fe:a9fe]/latest/meta-data",
      "https://[fd00::1]/",
      "https://169.254.169.254/latest/meta-data/",
      "https://100.100.100.200/",
    ]) {
      await refused(resolveWebhookTarget(url, strict), /Adresse refusée/);
    }
    await refused(resolveWebhookTarget("https://localhost:3000/", strict), /boucle locale/);
    await refused(resolveWebhookTarget("https://api.localhost./", strict), /boucle locale/);
    await refused(resolveWebhookTarget("http://hooks.example.com/", strict), /https:\/\//);
    await refused(resolveWebhookTarget("ftp://hooks.example.com/", strict), /https:\/\//);
    await refused(resolveWebhookTarget("https://user:pass@hooks.example.com/", strict), /Identifiants/);
    await refused(resolveWebhookTarget("https://user@hooks.example.com/", strict), /Identifiants/);
    await refused(resolveWebhookTarget("pas une url", strict), /URL invalide/);
  });

  it("nom introuvable ou sans adresse : refus « DNS »", async () => {
    const e = await refused(resolveWebhookTarget("https://nowhere.example.com/", strict), /introuvable/);
    expect(e.reason).toBe("dns");
    await refused(resolveWebhookTarget("https://empty.example.com/", strict), /introuvable/);
    const failing: Resolver = async () => Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" }));
    await refused(resolveWebhookTarget("https://hooks.example.com/", { allowPrivate: false, resolve: failing }), /Résolution DNS impossible \(ESERVFAIL\)/);
  });

  it("WEBHOOK_ALLOW_PRIVATE_URLS=1 (tests) : adresses internes, localhost et http:// acceptés ; identifiants toujours refusés", async () => {
    const lax = { allowPrivate: true, resolve };
    expect((await resolveWebhookTarget("http://127.0.0.1:8080/hook", lax)).addresses).toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect((await resolveWebhookTarget("http://127.0.0.1:8080/hook", lax)).port).toBe(8080);
    expect((await resolveWebhookTarget("https://evil.example.com/", lax)).addresses).toHaveLength(2);
    expect((await resolveWebhookTarget("http://[::1]/", lax)).hostname).toBe("::1");
    await refused(resolveWebhookTarget("http://u:p@127.0.0.1/", lax), /Identifiants/);
    await refused(resolveWebhookTarget("ftp://127.0.0.1/", lax), /https:\/\//);
  });

  it("variable d'environnement : « 1 » exactement", () => {
    expect(webhookAllowPrivate({})).toBe(false);
    expect(webhookAllowPrivate({ WEBHOOK_ALLOW_PRIVATE_URLS: "" })).toBe(false);
    expect(webhookAllowPrivate({ WEBHOOK_ALLOW_PRIVATE_URLS: "0" })).toBe(false);
    expect(webhookAllowPrivate({ WEBHOOK_ALLOW_PRIVATE_URLS: "true" })).toBe(false);
    expect(webhookAllowPrivate({ WEBHOOK_ALLOW_PRIVATE_URLS: "1" })).toBe(true);
    expect(webhookAllowPrivate({ WEBHOOK_ALLOW_PRIVATE_URLS: " 1 " })).toBe(true);
  });
});

describe("webhooks — lookup épinglé", () => {
  const addresses = [
    { address: "93.184.215.14", family: 4 as const },
    { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 as const },
  ];
  const call = (options: object) =>
    new Promise<unknown[]>((resolve) => (pinnedLookup(addresses) as any)("n-importe-quel-nom.example", options, (...args: unknown[]) => resolve(args)));

  it("renvoie les adresses validées, jamais une nouvelle résolution", async () => {
    expect(await call({})).toEqual([null, "93.184.215.14", 4]);
    expect(await call({ family: 6 })).toEqual([null, "2606:2800:21f:cb07:6820:80da:af6b:8b2c", 6]);
    expect(await call({ family: "IPv4" })).toEqual([null, "93.184.215.14", 4]);
    expect(await call({ all: true })).toEqual([null, addresses]);
    expect(await call({ all: true, family: 4 })).toEqual([null, [addresses[0]]]);
  });

  it("famille sans adresse validée : erreur ENOTFOUND", async () => {
    const [error] = await new Promise<unknown[]>((resolve) =>
      (pinnedLookup([addresses[0]!]) as any)("x", { family: 6 }, (...args: unknown[]) => resolve(args)),
    );
    expect((error as { code?: string }).code).toBe("ENOTFOUND");
  });
});
