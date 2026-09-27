import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { ipBucket } = await import("./request");

describe("ipBucket : seau de limitation de débit", () => {
  it("IPv4 inchangée, absente → 0.0.0.0", () => {
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(ipBucket(null)).toBe("0.0.0.0");
    expect(ipBucket("")).toBe("0.0.0.0");
  });

  it("IPv6 : toutes les adresses d'un même /64 partagent le même seau", () => {
    const a = ipBucket("2001:db8:85a3:12::1");
    expect(a).toBe("2001:0db8:85a3:0012::/64");
    expect(ipBucket("2001:db8:85a3:12:ffff:ffff:ffff:fffe")).toBe(a);
    expect(ipBucket("2001:0DB8:85A3:0012:0:0:0:abcd")).toBe(a);
    expect(ipBucket("[2001:db8:85a3:12::42]")).toBe(a);
    expect(ipBucket("2001:db8:85a3:13::1")).not.toBe(a);
  });

  it("IPv4 encapsulée → IPv4 ; adresse invalide gardée telle quelle", () => {
    expect(ipBucket("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(ipBucket("::1")).toBe("0000:0000:0000:0000::/64");
    expect(ipBucket("n'importe:quoi::x:y:z:1:2:3")).toBe("n'importe:quoi::x:y:z:1:2:3");
  });
});
