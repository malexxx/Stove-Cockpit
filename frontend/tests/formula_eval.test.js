import { describe, expect, it } from "vitest";
import { evaluateMicronovaFormula } from "../src/micronova/formula_eval.js";

describe("evaluateMicronovaFormula", () => {
  it("évalue les formules arithmétiques Micronova courantes", () => {
    expect(evaluateMicronovaFormula("#", 42)).toBe(42);
    expect(evaluateMicronovaFormula("#*0.5", 41)).toBe(20.5);
    expect(evaluateMicronovaFormula("#/2", 45)).toBe(22.5);
    expect(evaluateMicronovaFormula("(#-30)*0.5", 70)).toBe(20);
    expect(evaluateMicronovaFormula("#/10", 125)).toBe(12.5);
    expect(evaluateMicronovaFormula("#Mod100", 235)).toBe(35);
    expect(evaluateMicronovaFormula("# Mod 100", 235)).toBe(35);
    expect(evaluateMicronovaFormula("INT(#/10)", 29)).toBe(2);
    expect(evaluateMicronovaFormula("IF(#>=5, 10, 0)", 5)).toBe(10);
  });

  it("retranscrit les formules logiques de masques et comparaisons (0/1)", () => {
    expect(evaluateMicronovaFormula("#>=5", 5)).toBe(1);
    expect(evaluateMicronovaFormula("#==0", 1)).toBe(0);
  });

  it("rejette toute expression malveillante ou jeton non autorisé", () => {
    expect(() => evaluateMicronovaFormula("process.exit(1)", 1)).toThrow();
    expect(() => evaluateMicronovaFormula("window.alert(#)", 1)).toThrow();
    expect(evaluateMicronovaFormula("", 1)).toBe(1);
  });
});
