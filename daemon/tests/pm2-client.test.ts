import { beforeEach, describe, expect, it, vi } from "vitest";
import pm2 from "pm2";
import {
  isAppOnline,
  pm2Connect,
  pm2Delete,
  pm2Disconnect,
  pm2List,
  pm2Start,
  pm2Stop,
  withPm2Connection,
} from "../src/infra/pm2-client.js";

vi.mock("pm2", () => ({
  default: {
    connect: vi.fn(),
    start: vi.fn(),
    list: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    disconnect: vi.fn(),
  },
}));

const pm2Mock = vi.mocked(pm2, { deep: true });

describe("pm2-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("pm2Connect", () => {
    it("resolves when pm2.connect succeeds", async () => {
      pm2Mock.connect.mockImplementation((cb) => cb(null));

      await expect(pm2Connect()).resolves.toBeUndefined();
      expect(pm2Mock.connect).toHaveBeenCalledTimes(1);
    });

    it("rejects when pm2.connect returns an error", async () => {
      const error = new Error("connect failed");
      pm2Mock.connect.mockImplementation((cb) => cb(error));

      await expect(pm2Connect()).rejects.toThrow("connect failed");
    });
  });

  describe("pm2Start", () => {
    it("resolves with proc and passes config path", async () => {
      const configPath = "/tmp/ecosystem.config.cjs";
      const mockProc = { pm_id: 1 };
      pm2Mock.start.mockImplementation((path, cb) => cb(null, mockProc as never));

      await expect(pm2Start(configPath)).resolves.toBe(mockProc);
      expect(pm2Mock.start).toHaveBeenCalledWith(configPath, expect.any(Function));
    });

    it("rejects when pm2.start returns an error", async () => {
      const error = new Error("start failed");
      pm2Mock.start.mockImplementation((_path, cb) => cb(error));

      await expect(pm2Start("/tmp/ecosystem.config.cjs")).rejects.toThrow("start failed");
    });
  });

  describe("pm2List", () => {
    it("resolves with process list", async () => {
      const processes = [{ name: "app-a" }, { name: "app-b" }];
      pm2Mock.list.mockImplementation((cb) => cb(null, processes as never));

      await expect(pm2List()).resolves.toBe(processes);
    });

    it("rejects when pm2.list returns an error", async () => {
      const error = new Error("list failed");
      pm2Mock.list.mockImplementation((cb) => cb(error));

      await expect(pm2List()).rejects.toThrow("list failed");
    });
  });

  describe("pm2Stop", () => {
    it("resolves with proc", async () => {
      const mockProc = { pm_id: 2 };
      pm2Mock.stop.mockImplementation((_target, cb) => cb(null, mockProc as never));

      await expect(pm2Stop("worker")).resolves.toBe(mockProc);
    });

    it("rejects when pm2.stop returns an error", async () => {
      const error = new Error("stop failed");
      pm2Mock.stop.mockImplementation((_target, cb) => cb(error));

      await expect(pm2Stop(3)).rejects.toThrow("stop failed");
    });
  });

  describe("pm2Delete", () => {
    it("resolves with proc", async () => {
      const mockProc = { pm_id: 3 };
      pm2Mock.delete.mockImplementation((_target, cb) => cb(null, mockProc as never));

      await expect(pm2Delete("worker")).resolves.toBe(mockProc);
    });

    it("rejects when pm2.delete returns an error", async () => {
      const error = new Error("delete failed");
      pm2Mock.delete.mockImplementation((_target, cb) => cb(error));

      await expect(pm2Delete(4)).rejects.toThrow("delete failed");
    });
  });

  describe("pm2Disconnect", () => {
    it("calls pm2.disconnect", () => {
      pm2Disconnect();

      expect(pm2Mock.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("withPm2Connection", () => {
    it("connects, runs fn, disconnects, and returns fn result", async () => {
      pm2Mock.connect.mockImplementation((cb) => cb(null));
      const fn = vi.fn().mockResolvedValue("result");

      await expect(withPm2Connection(fn)).resolves.toBe("result");

      expect(pm2Mock.connect).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(pm2Mock.disconnect).toHaveBeenCalledTimes(1);
      expect(pm2Mock.connect.mock.invocationCallOrder[0]).toBeLessThan(fn.mock.invocationCallOrder[0]);
      expect(fn.mock.invocationCallOrder[0]).toBeLessThan(pm2Mock.disconnect.mock.invocationCallOrder[0]);
    });

    it("disconnects even when fn throws", async () => {
      pm2Mock.connect.mockImplementation((cb) => cb(null));
      const fn = vi.fn().mockRejectedValue(new Error("fn failed"));

      await expect(withPm2Connection(fn)).rejects.toThrow("fn failed");

      expect(pm2Mock.connect).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(pm2Mock.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe("isAppOnline", () => {
    it("returns true when app exists and status is online", async () => {
      pm2Mock.list.mockImplementation((cb) =>
        cb(null, [{ name: "kilo-daemon", pm2_env: { status: "online" } }] as never),
      );

      await expect(isAppOnline("kilo-daemon")).resolves.toBe(true);
    });

    it("returns false when app is not found", async () => {
      pm2Mock.list.mockImplementation((cb) =>
        cb(null, [{ name: "other-app", pm2_env: { status: "online" } }] as never),
      );

      await expect(isAppOnline("kilo-daemon")).resolves.toBe(false);
    });

    it("returns false when app exists but is not online", async () => {
      pm2Mock.list.mockImplementation((cb) =>
        cb(null, [{ name: "kilo-daemon", pm2_env: { status: "stopped" } }] as never),
      );

      await expect(isAppOnline("kilo-daemon")).resolves.toBe(false);
    });

    it("returns false when pm2.list throws", async () => {
      pm2Mock.list.mockImplementation((cb) => cb(new Error("list failed")));

      await expect(isAppOnline("kilo-daemon")).resolves.toBe(false);
    });
  });
});
