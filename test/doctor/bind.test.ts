import { describe, expect, test } from "bun:test";
import { parseListenHosts, isLocalhostOnly } from "../../src/doctor/bind.ts";

const header =
  "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n";

describe("parseListenHosts", () => {
  test("reads the bind address off a LISTEN row", () => {
    const output =
      header + "python3.1 12617 sam   19u  IPv4 0x1342e3de      0t0  TCP 127.0.0.1:6767 (LISTEN)\n";
    expect(parseListenHosts(output)).toEqual(["127.0.0.1"]);
  });

  test("ignores established connections — only what is listening matters", () => {
    const output =
      header +
      "python3.1 12617 sam    4u  IPv4 0xf7d7f3a8      0t0  TCP 127.0.0.1:6767->127.0.0.1:58635 (ESTABLISHED)\n" +
      "python3.1 12617 sam   19u  IPv4 0x1342e3de      0t0  TCP 127.0.0.1:6767 (LISTEN)\n";
    expect(parseListenHosts(output)).toEqual(["127.0.0.1"]);
  });

  test("reads an IPv6 loopback bind", () => {
    const output = header + "python3.1 12617 sam 19u IPv6 0x1 0t0 TCP [::1]:6767 (LISTEN)\n";
    expect(parseListenHosts(output)).toEqual(["::1"]);
  });

  test("reads a wide-open bind", () => {
    const output = header + "python3.1 12617 sam 19u IPv4 0x1 0t0 TCP *:6767 (LISTEN)\n";
    expect(parseListenHosts(output)).toEqual(["*"]);
  });

  test("returns nothing for empty output", () => {
    expect(parseListenHosts("")).toEqual([]);
    expect(parseListenHosts(header)).toEqual([]);
  });
});

describe("isLocalhostOnly", () => {
  test("loopback addresses pass", () => {
    expect(isLocalhostOnly(["127.0.0.1"])).toBe(true);
    expect(isLocalhostOnly(["::1", "127.0.0.1"])).toBe(true);
    expect(isLocalhostOnly(["localhost"])).toBe(true);
  });

  test("anything reachable from the network fails", () => {
    expect(isLocalhostOnly(["*"])).toBe(false);
    expect(isLocalhostOnly(["0.0.0.0"])).toBe(false);
    expect(isLocalhostOnly(["192.168.1.20"])).toBe(false);
    expect(isLocalhostOnly(["127.0.0.1", "0.0.0.0"])).toBe(false);
  });

  test("nothing listening is not the same as safely bound", () => {
    expect(isLocalhostOnly([])).toBe(false);
  });
});
