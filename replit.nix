{ pkgs }: {
  deps = [
    pkgs.psmisc
    pkgs.nano

    # Browser
    pkgs.chromium

    # C/C++ runtime
    pkgs.stdenv.cc.cc

    # Core
    pkgs.glib
    pkgs.nss
    pkgs.nspr
    pkgs.expat

    # GTK / accessibility
    pkgs.atk
    pkgs.at-spi2-atk
    pkgs.at-spi2-core
    pkgs.gtk3

    # Graphics / rendering
    pkgs.libdrm
    pkgs.mesa
    pkgs.pango
    pkgs.cairo
    pkgs.freetype
    pkgs.fontconfig
    pkgs.gdk-pixbuf

    # X11
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.xorg.libXcomposite
    pkgs.xorg.libXdamage
    pkgs.xorg.libXext
    pkgs.xorg.libXfixes
    pkgs.xorg.libXrandr
    pkgs.xorg.libXcursor
    pkgs.xorg.libXi
    pkgs.xorg.libXrender
    pkgs.xorg.libxshmfence

    # Keyboard / audio
    pkgs.libxkbcommon
    pkgs.alsa-lib

    # System
    pkgs.cups
    pkgs.dbus
  ];
} 
