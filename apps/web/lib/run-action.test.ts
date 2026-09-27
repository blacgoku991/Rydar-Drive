import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { redirect } from "next/navigation";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_FAILED_MESSAGE, ACTION_OUTDATED_MESSAGE, actionFailureMessage, runAction } from "./run-action";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("runAction", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("renvoie le résultat de l'action, sans toast", async () => {
    await expect(runAction(async () => ({ ok: true as const }))).resolves.toEqual({ ok: true });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("action introuvable après un déploiement : toast « Nouvelle version disponible » avec « Recharger », pas d'exception", async () => {
    const fail = new UnrecognizedActionError('Server Action "abc" was not found on the server.');
    await expect(runAction(async () => { throw fail; })).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message, opts] = vi.mocked(toast.error).mock.calls[0]!;
    expect(message).toBe(ACTION_OUTDATED_MESSAGE);
    expect(opts).toMatchObject({ action: { label: "Recharger" } });
    expect(actionFailureMessage(fail)).toBe(ACTION_OUTDATED_MESSAGE);
  });

  it("réseau coupé / erreur serveur : message générique, pas d'exception", async () => {
    await expect(runAction(async () => { throw new TypeError("Failed to fetch"); })).resolves.toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(ACTION_FAILED_MESSAGE);
  });

  it("onError remplace le toast", async () => {
    const onError = vi.fn();
    await runAction(async () => { throw new Error("boom"); }, onError);
    expect(onError).toHaveBeenCalledWith(ACTION_FAILED_MESSAGE);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("redirect() d'une action : relancé pour que Next navigue", async () => {
    let navigation: unknown;
    try {
      redirect("/dashboard");
    } catch (e) {
      navigation = e;
    }
    await expect(runAction(async () => { throw navigation; })).rejects.toBe(navigation);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
