"use server";
// Test d'éligibilité Flotte Privée (logique : lib/eligibility.ts).
import { submitEligibility, type EligibilityFormInput, type EligibilityResult } from "@/lib/eligibility";

export async function sendEligibility(input: EligibilityFormInput): Promise<EligibilityResult> {
  return submitEligibility(input);
}
