import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Field relie son libellé, son aide ou son erreur et l'état d'erreur au contrôle qu'il contient (WCAG 1.3.1, 3.3.1,
// 4.1.2 ; RGAA 11.1, 11.10) : audit du 3 octobre 2026, 182 champs sur 211 n'avaient pas d'étiquette reliée.

vi.mock("@/lib/utils", async () => await import("../../lib/utils"));

const { Field, Input, NativeSelect, Textarea, asFieldControl } = await import("./input");

const render = (node: ReactNode) => renderToStaticMarkup(node as never);
/** Field avec son contrôle (children passé dans les props, comme en JSX). */
const field = (props: Omit<Parameters<typeof Field>[0], "children">, child: ReactNode) => createElement(Field, { ...props, children: child });
/** Attribut d'une balise (première occurrence). */
const attr = (html: string, tag: string, name: string) => new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`).exec(html)?.[1];

describe("Field : libellé, aide et erreur reliés au champ", () => {
  it("libellé relié à l'input (id généré), aide annoncée par aria-describedby", () => {
    const html = render(field({ label: "Nom", hint: "Tel qu'écrit sur la carte" }, createElement(Input, { name: "name" })));
    const id = attr(html, "input", "id");
    expect(id).toBeTruthy();
    expect(attr(html, "label", "for")).toBe(id);
    const describedBy = attr(html, "input", "aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).not.toContain("aria-invalid");
  });

  it("erreur : aria-invalid et message relié (à la place de l'aide)", () => {
    const html = render(field({ label: "E-mail", hint: "aide", error: "Adresse invalide" }, createElement(Input, { name: "email" })));
    expect(attr(html, "input", "aria-invalid")).toBe("true");
    const describedBy = attr(html, "input", "aria-describedby")!;
    expect(new RegExp(`<p id="${describedBy}"[^>]*>Adresse invalide</p>`).test(html)).toBe(true);
    expect(html).not.toContain(">aide<");
  });

  it("champ dans un conteneur (mot de passe + bouton) : le premier contrôle est relié, pas le bouton", () => {
    const html = render(
      field({ label: "Mot de passe" },
        createElement("div", { className: "relative" }, createElement(Input, { name: "password", type: "password" }), createElement("button", { type: "button" }, "Afficher")),
      ),
    );
    expect(attr(html, "label", "for")).toBe(attr(html, "input", "id"));
    expect(attr(html, "button", "id")).toBeUndefined();
  });

  it("id, aria-invalid et aria-describedby déjà posés : gardés (aria-describedby complété)", () => {
    const html = render(
      field({ label: "Code", hint: "6 chiffres", error: undefined }, createElement(Input, { id: "code", "aria-describedby": "regle", "aria-invalid": false })),
    );
    expect(attr(html, "input", "id")).toBe("code");
    expect(attr(html, "label", "for")).toBe("code");
    expect(attr(html, "input", "aria-describedby")).toMatch(/^regle \S+$/);
    expect(attr(html, "input", "aria-invalid")).toBe("false");
  });

  it("htmlFor explicite : utilisé pour le libellé et l'id du champ", () => {
    const html = render(field({ label: "Montant", htmlFor: "amount" }, createElement(Input, { name: "amount" })));
    expect(attr(html, "label", "for")).toBe("amount");
    expect(attr(html, "input", "id")).toBe("amount");
  });

  it("liste déroulante et zone de texte reliées", () => {
    const select = render(field({ label: "Paiement" }, createElement(NativeSelect, null, createElement("option", { value: "a" }, "A"))));
    expect(attr(select, "label", "for")).toBe(attr(select, "select", "id"));
    const area = render(field({ label: "Message" }, createElement(Textarea, { name: "m" })));
    expect(attr(area, "label", "for")).toBe(attr(area, "textarea", "id"));
  });

  it("composant déclaré par asFieldControl : reçoit id et aria-* ; composant inconnu : libellé sans for (jamais un for vers rien)", () => {
    const Unit = asFieldControl(function Unit(props: Record<string, unknown>) {
      return createElement("div", null, createElement("input", { ...props }), createElement("span", null, "km"));
    });
    const html = render(field({ label: "Rayon", hint: "en km" }, createElement(Unit, { name: "r" })));
    expect(attr(html, "label", "for")).toBe(attr(html, "input", "id"));
    expect(attr(html, "input", "aria-describedby")).toBeTruthy();
    function Picker() {
      return createElement("div", { role: "radiogroup", "aria-label": "Moyen" });
    }
    const other = render(field({ label: "Moyen" }, createElement(Picker)));
    expect(attr(other, "label", "for")).toBeUndefined();
  });
});
