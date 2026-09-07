{
  description = "@tummycrypt/tinyland-auth-pg - PostgreSQL storage adapter for tinyland-auth";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        pnpmPackage = if pkgs ? pnpm_10 then pkgs.pnpm_10 else pkgs.pnpm;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.bazelisk
            pkgs.just
            pkgs.nodejs_22
            pnpmPackage
          ];
          shellHook = ''
            echo "tinyland-auth-pg dev shell"
            echo "  node $(node --version)"
            echo "  pnpm $(pnpm --version)"
            echo "  bazel $(bazelisk --version | head -n1)"
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
