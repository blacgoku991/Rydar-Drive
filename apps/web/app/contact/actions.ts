"use server";
// Formulaire de contact public (logique : lib/contact.ts).
import { submitContactRequest, type ContactInput, type ContactResult } from "@/lib/contact";

export type { ContactInput, ContactResult };

export async function sendContactRequest(input: ContactInput): Promise<ContactResult> {
  return submitContactRequest(input);
}
