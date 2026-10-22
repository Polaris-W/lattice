/**
 * 设置菜单
 *
 * 顶栏右上角那颗头像/齿轮按钮点开的就是它。菜单里放三类东西：
 *   1. 账号 —— 登录、个人信息、退出
 *   2. 外观 —— 明暗主题（浅色 / 跟随系统 / 深色）
 *   3. 画布行为 —— 网格吸附，和顶栏那个按钮绑同一份状态
 *
 * 关于"账号"的定位：棂是纯本地应用，没有服务端。这里的登录只是给这台
 * 机器起一个名字，写进 `lattice.platform.v1`，不上传、不联网。文案上
 * 明确写"只保存在这台电脑"，免得让人以为注册了云端账号。
 * 真要做多设备同步时，把 store 里的 signIn/signOut 换成网络实现即可，
 * 这个组件不用动。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Glyph, ICON, ThemeGlyph } from "./icons";
import { useLattice, type ThemeMode } from "./store";

type View = "menu" | "signin" | "profile";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
];

function Avatar({ name, size }: { name?: string; size: number }) {
  const initial = name?.trim().slice(0, 1).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (!initial) {
    return (
      <span className="lattice-avatar is-empty" style={style} aria-hidden="true">
        <Glyph d={ICON.user} size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <span className="lattice-avatar" style={style} aria-hidden="true">
      {initial}
    </span>
  );
}

interface SettingsMenuProps {
  installedCount: number;
  placementCount: number;
}

export function SettingsMenu({ installedCount, placementCount }: SettingsMenuProps) {
  const profile = useLattice((state) => state.profile);
  const signIn = useLattice((state) => state.signIn);
  const signOut = useLattice((state) => state.signOut);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const toggleSnap = useLattice((state) => state.toggleSnap);

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [draftName, setDraftName] = useState("");
  const [draftEmail, setDraftEmail] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setView("menu");
  }, []);

  const startSignIn = useCallback(() => {
    setDraftName(profile?.name ?? "");
    setDraftEmail(profile?.email ?? "");
    setView("signin");
  }, [profile]);

  const startProfile = useCallback(() => {
    setDraftName(profile?.name ?? "");
    setDraftEmail(profile?.email ?? "");
    setView("profile");
  }, [profile]);

  // Ctrl+, 打开设置（和大多数桌面应用的约定一致），Esc 关闭
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // 点到菜单外面就收起来。用 pointerdown 而不是 click：
  // 前者在鼠标按下时就触发，不会出现"点画布先选中组件、菜单还浮在上面"的错位
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const name = draftName.trim();
      if (!name) return;
      signIn(name, draftEmail);
      setView("menu");
    },
    [draftEmail, draftName, signIn],
  );

  const signedIn = Boolean(profile);

  return (
    <div className="lattice-settings" ref={rootRef}>
      <button
        type="button"
        className={`lattice-settings-trigger${open ? " is-open" : ""}`}
        onClick={() => {
          if (open) close();
          else {
            setView("menu");
            setOpen(true);
          }
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Settings (Ctrl+,)"
      >
        <Avatar name={profile?.name} size={24} />
      </button>

      {open && (
        <div className="lattice-menu" role="dialog" aria-label="Settings">
          {view === "menu" && (
            <>
              <header className="lattice-account">
                <Avatar name={profile?.name} size={38} />
                <div className="lattice-account-text">
                  <div className="lattice-account-name">{profile?.name ?? "Not signed in"}</div>
                  <div className="lattice-account-sub">
                    {profile ? profile.email || "Local profile" : "Sign in to keep your preferences"}
                  </div>
                </div>
              </header>

              <div className="lattice-account-card">
                <div className="lattice-account-stats">
                  <div>
                    <span>Installed</span>
                    <b>{installedCount}</b>
                  </div>
                  <div>
                    <span>On canvas</span>
                    <b>{placementCount}</b>
                  </div>
                </div>
                <button
                  type="button"
                  className={`lattice-btn is-small${profile ? "" : " is-primary"}`}
                  onClick={profile ? startProfile : startSignIn}
                >
                  {profile ? "Edit profile" : "Sign in"}
                </button>
              </div>

              <div className="lattice-menu-list">
                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.appearance} />
                  <span className="lattice-menu-label">Appearance</span>
                  <div className="lattice-segmented is-compact is-icons">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`lattice-segment${theme === option.value ? " is-active" : ""}`}
                        onClick={() => setTheme(option.value)}
                        aria-pressed={theme === option.value}
                        title={option.label}
                        aria-label={option.label}
                      >
                        <ThemeGlyph mode={option.value} />
                      </button>
                    ))}
                  </div>
                </div>

                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.grid} />
                  <span className="lattice-menu-label">Snap to grid</span>
                  <label className="lattice-switch" title="Align to an 8px grid while dragging">
                    <input
                      type="checkbox"
                      checked={snapToGrid}
                      onChange={toggleSnap}
                      aria-label="Snap to grid"
                    />
                  </label>
                </div>

                <button
                  type="button"
                  className="lattice-menu-row"
                  onClick={profile ? startProfile : startSignIn}
                >
                  <Glyph d={ICON.user} />
                  <span className="lattice-menu-label">Profile</span>
                  <Glyph d={ICON.chevron} size={13} />
                </button>

                <div className="lattice-menu-row is-static">
                  <Glyph d={ICON.info} />
                  <span className="lattice-menu-label">About Lattice</span>
                  <span className="lattice-menu-note">v0.1.0 · local-first</span>
                </div>
              </div>

              {signedIn && (
                <>
                  <div className="lattice-menu-divider" />
                  <button
                    type="button"
                    className="lattice-menu-row is-danger"
                    onClick={() => {
                      signOut();
                      close();
                    }}
                  >
                    <Glyph d={ICON.logout} />
                    <span className="lattice-menu-label">Sign out</span>
                  </button>
                </>
              )}
            </>
          )}

          {view !== "menu" && (
            <form className="lattice-account-form" onSubmit={submit}>
              <header className="lattice-account-form-head">
                <button type="button" className="lattice-icon-btn" onClick={() => setView("menu")}>
                  <Glyph d={ICON.back} />
                  <span className="lattice-sr-only">Back</span>
                </button>
                <span>{view === "profile" ? "Profile" : "Sign in"}</span>
              </header>

              <div className="lattice-account-form-body">
                <div className="lattice-account-preview">
                  <Avatar name={draftName || profile?.name} size={46} />
                  <div>
                    <div className="lattice-account-name">{draftName.trim() || "Your name"}</div>
                    <div className="lattice-account-sub">{draftEmail.trim() || "No email yet"}</div>
                  </div>
                </div>

                <label className="lattice-textfield">
                  <span>Display name</span>
                  <input
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                    placeholder="What should we call you?"
                    maxLength={24}
                    autoFocus
                  />
                </label>

                <label className="lattice-textfield">
                  <span>Email (optional)</span>
                  <input
                    value={draftEmail}
                    onChange={(event) => setDraftEmail(event.target.value)}
                    placeholder="you@example.com"
                    inputMode="email"
                    maxLength={64}
                  />
                </label>

                <p className="lattice-account-hint">
                  Stored on this computer only. Nothing is uploaded, no password needed, and it is removed with the rest of the platform data.
                </p>
              </div>

              <footer className="lattice-account-form-foot">
                <button type="button" className="lattice-btn is-small" onClick={() => setView("menu")}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="lattice-btn is-small is-primary"
                  disabled={!draftName.trim()}
                >
                  {view === "profile" ? "Save" : "Sign in"}
                </button>
              </footer>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
