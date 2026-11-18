/**
 * @test-id DESKTOP-ADMIN-ACCOUNT-USES-APP-001
 * @level unit
 * @why ACCT-AUTH-07: an admin account must reach the app like any other account. Before 2026-10-26 the
 *      desktop auth guard replaced the whole app with "Admin accounts cannot use the consumer app".
 * @covers apps/badger/desktop/src/renderer/src/App.tsx
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../src/renderer/src/App";

const auth = vi.hoisted(() => ({
  value: {
    loading: false,
    user: { id: "u1", email: "admin@example.test", isAdmin: true } as { id: string; email: string; isAdmin: boolean } | null,
  },
}));

vi.mock("../src/renderer/src/auth", () => ({
  AuthProvider: ({ children }: { children: unknown }) => children,
  useAuth: () => auth.value,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const render = () =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={["/"]}>
      <RequireAuth>
        <div>library-home</div>
      </RequireAuth>
    </MemoryRouter>
  );

describe("desktop auth guard and admin accounts", () => {
  beforeEach(() => {
    auth.value = { loading: false, user: { id: "u1", email: "admin@example.test", isAdmin: true } };
  });

  // @req ACCT-AUTH-07[badger-desktop]
  it("lets a signed-in admin account into the app", () => {
    const html = render();
    console.info(`[admin-account-uses-app] user=${JSON.stringify(auth.value.user)} html=${html}`);
    expect(html, "the app must render for an admin account").toContain("library-home");
  });

  it("still holds a signed-out visitor back from the app", () => {
    auth.value = { loading: false, user: null };
    const html = render();
    console.info(`[admin-account-uses-app:signed-out] html=${JSON.stringify(html)}`);
    expect(html).not.toContain("library-home");
  });
});
