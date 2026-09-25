{
  description =
    "@tummycrypt/tinyland-auth-pg - PostgreSQL storage adapter for tinyland-auth";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      overlay = final: prev: {
        tinyland-auth-pg = final.callPackage ./nix/package.nix {
          version = packageJson.version;
        };
      };
    in flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
      in {
        packages.default = pkgs.tinyland-auth-pg;
        packages.tinyland-auth-pg = pkgs.tinyland-auth-pg;

        checks.default = pkgs.tinyland-auth-pg;

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ bazel_8 nodejs_22 (pkgs.pnpm_10 or pkgs.pnpm) ];
          shellHook = ''
            echo "tinyland-auth-pg dev shell"
            echo "  node $(node --version)"
            echo "  pnpm $(pnpm --version)"
            echo "  bazel $(bazel --version | head -n1)"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }) // {
        overlays.default = overlay;
      };
}
