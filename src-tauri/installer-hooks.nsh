; 棂 / Lattice —— NSIS 安装器钩子
;
; 只在 `bundle.targets` 含 nsis 时生效（见 tauri.conf.json 的
; bundle.windows.nsis.installerHooks）。
;
; # 为什么安装时**不**默认打开自启
;
; 开机自启是用户的选择，不是安装包的赠品。装完应用就多一条启动项，是这个
; 品类最招人烦的行为之一 —— 而且用户往往几天后才发现，还不知道是谁加的。
; 所以安装这一步不动注册表：开关在应用里（设置菜单 → Start with Windows，
; 见 src-tauri/src/autostart.rs）。
;
; # 那"路径变了"怎么办
;
; 交给应用自己。它知道自己的 exe 在哪（`std::env::current_exe()`），比在
; NSIS 里拼 `$INSTDIR\...\exe` 可靠得多 —— 后者要依赖模板里的 define，
; 模板一改这里就悄悄编错。启动时对一次账即可，见 `autostart::reconcile()`。
;
; # 卸载必须清
;
; 这是安装器**唯一**必须做的一件事：不删的话，系统每次登录都会尝试启动一个
; 已经不存在的 exe。应用自己做不到 —— 那时候它已经被删掉了。

!macro NSIS_HOOK_PREUNINSTALL
  ; 只删值，不删键：Run 是系统的键，里面还有别的应用的启动项
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Lattice"
!macroend
