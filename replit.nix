{ pkgs }: {
  deps = [
    pkgs.chromium
    pkgs.glib
    pkgs.nss
    pkgs.nspr
    pkgs.atk
    pkgs.at-spi2-atk
    pkgs.cups
    pkgs.dbus
    pkgs.libdrm
    pkgs.xorg.libxcb
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXdamage
    pkgs.xorg.libXrandr
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXcursor
    pkgs.xorg.libXi
    pkgs.xorg.libXrender
    pkgs.xorg.libXtst
    pkgs.pango
    pkgs.cairo
    pkgs.alsa-lib
    pkgs.at-spi2-core
    pkgs.gtk3
  ];
}