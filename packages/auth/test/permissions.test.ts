import { describe, expect, it } from "vitest";
import { can, isPermission, PERMISSIONS, SYSTEM_ROLES, type CheckablePermission } from "../src/permissions.ts";

const actor = (role: keyof typeof SYSTEM_ROLES, userId = "u1") => ({
  userId,
  permissions: new Set<string>(SYSTEM_ROLES[role]),
});

// The permission matrix from the architecture doc, row by row.
const MATRIX: Record<CheckablePermission, [boolean, boolean, boolean, boolean | "own", boolean]> = {
  //                         Owner  Admin  Editor Contrib Viewer
  "asset.view":              [true, true,  true,  true,  true],
  "asset.upload":            [true, true,  true,  true,  false],
  "asset.edit":              [true, true,  true,  "own", false],
  "asset.delete":            [true, true,  true,  "own", false],
  "asset.download_original": [true, true,  true,  true,  false],
  "album.manage":            [true, true,  true,  false, false],
  "share.create":            [true, true,  true,  false, false],
  "share.public_gallery":    [true, true,  false, false, false],
  "member.manage":           [true, true,  false, false, false],
  "site.settings":           [true, true,  false, false, false],
  "tenant.delete":           [true, false, false, false, false],
};
const ROLES = ["Owner", "Admin", "Editor", "Contributor", "Viewer"] as const;

describe("system roles", () => {
  for (const [permission, row] of Object.entries(MATRIX) as [CheckablePermission, (typeof MATRIX)[CheckablePermission]][]) {
    ROLES.forEach((role, i) => {
      const expected = row[i];
      it(`${role} ${expected === false ? "cannot" : "can"} ${permission}${expected === "own" ? " (own only)" : ""}`, () => {
        const mine = { ownerId: "u1" };
        const theirs = { ownerId: "u2" };
        if (expected === "own") {
          expect(can(actor(role), permission, mine)).toBe(true);
          expect(can(actor(role), permission, theirs)).toBe(false);
          expect(can(actor(role), permission)).toBe(false);
        } else {
          expect(can(actor(role), permission, theirs)).toBe(expected);
        }
      });
    });
  }

  it("only uses known permission names", () => {
    for (const perms of Object.values(SYSTEM_ROLES)) {
      for (const p of perms) expect(isPermission(p)).toBe(true);
    }
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});

describe("can()", () => {
  it("denies anonymous callers", () => {
    expect(can(null, "asset.view")).toBe(false);
    expect(can(undefined, "asset.view")).toBe(false);
  });

  it("accepts permission arrays as well as sets", () => {
    expect(can({ userId: "u", permissions: ["asset.view"] }, "asset.view")).toBe(true);
  });

  it("doesn't treat a missing owner as the caller's", () => {
    expect(can(actor("Contributor"), "asset.edit", { ownerId: null })).toBe(false);
  });
});
