{
  description = "Workflow control for AI coding agents";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
        in
        {
          default = pkgs.buildNpmPackage {
            pname = "takt";
            version = packageJson.version;
            src = ./.;

            npmDepsHash = "sha256-30s2qDg8wzg8EPFwkzXr0vpj3ugD4kxW/ox+x2DSPVo=";
            nodejs = nodejs;
            ONNXRUNTIME_NODE_INSTALL = "skip";
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

            meta = {
              description = packageJson.description;
              homepage = packageJson.homepage;
              license = pkgs.lib.licenses.mit;
              mainProgram = "takt";
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
        in
        {
          default = pkgs.mkShell {
            packages = [
              nodejs
              pkgs.bun
            ];
          };
        }
      );
    };
}
