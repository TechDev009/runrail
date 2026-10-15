# Hosting profiles

These examples are validation inputs, not deployment manifests. They contain no
credentials and do not provision a service.

- `loopback-profile.json` is the safe local control-server shape.
- `reverse-proxy-profile.json` describes a caller-owned TLS reverse proxy with
  authenticated remote access and an explicitly supplied sandbox.

Load a profile with `parseHostingProfile` before passing matching values to an
embedding application's control server. The embedding application owns TLS
termination, identity, tenancy, durable state, certificates, and deployment.
