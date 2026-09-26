"use server";
// Inscription par le lien d'une centrale depuis la page web (logique commune : lib/join.ts).
import type { joinApplicationSchema } from "@rydar/shared";
import type { z } from "zod";
import { applyWithJoinLink, type JoinResult } from "@/lib/join";

export type { JoinResult };

export async function applyToCentrale(code: string, input: z.input<typeof joinApplicationSchema>): Promise<JoinResult> {
  return applyWithJoinLink(code, input);
}
