{ pkgs, lib ? pkgs.lib, version ? "0.2.1", packageSrc ? lib.cleanSource ./.. }:

let
  nodejs = pkgs.nodejs_22;
  pnpm = pkgs.pnpm_10 or pkgs.pnpm;
in pkgs.stdenv.mkDerivation {
  pname = "tinyland-auth-pg";
  inherit version;
  src = packageSrc;

  nativeBuildInputs = [ nodejs pnpm pkgs.pnpmConfigHook ];

  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "tinyland-auth-pg";
    inherit version;
    src = packageSrc;
    inherit pnpm;
    fetcherVersion = 3;
    hash = "sha256-IoyEv6w3aL4BMr7ExAOv8kOIZt22vKnUa5NFIUi/VfA=";
  };

  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/home"
    export CI=true
    mkdir -p "$HOME"
    pnpm --config.manage-package-manager-versions=false build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    package_root="$out/lib/node_modules/@tummycrypt/tinyland-auth-pg"
    mkdir -p "$package_root"
    cp -r dist drizzle drizzle-public package.json README.md CHANGELOG.md "$package_root"/
    runHook postInstall
  '';

  meta = with lib; {
    description = "PostgreSQL storage adapter for @tummycrypt/tinyland-auth";
    homepage = "https://github.com/xoxd-ai/tinyland-auth-pg";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.unix;
  };
}
