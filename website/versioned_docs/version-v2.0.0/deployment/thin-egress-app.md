---
id: version-v2.0.0-thin_egress_app
title: Thin Egress App
hide_title: true
original_id: thin_egress_app
---

# Using the Thin Egress App for Cumulus distribution

The [Thin Egress App (TEA)](https://github.com/asfadmin/thin-egress-app) is an app running in Lambda that allows retrieving data from S3 using temporary links and provides URS integration.

## Cumulus "Packaged" Deployment

If you are using the `cumulus` module or the core `distribution` module, you will not need to manually deploy TEA. Cumulus packages TEA within its `distribution` tf-module, which is pre-configured and included in our releases.

By default, Core provides a one-to-one mapping where each protected and public bucket map to a path of the same name as the bucket.

The `cumulus` and `distribution` modules provide a `bucket_map_key` input variable which allows you to specify the path to a custom [bucket map YAML](https://github.com/asfadmin/thin-egress-app#buckets-and-bucket-map) that's stored in the bucket defined in the `system bucket` cumulus/distribution module input variable.

**Note: Cumulus only supports a one-to-one mapping of bucket->path name. Mapping multiple paths to the same bucket will result in a deployment failure.**

## Manual Deployment

If you are using individual Cumulus modules in your own Terraform configuration, or wish to configure TEA on your own, the information below is important to set up distribution manually.

TEA is deployed using [Terraform](https://terraform.io) modules. Refer to [these instructions](./components) for guidance on how to integrate new components with your deployment.

The TEA module provides [these instructions](https://github.com/asfadmin/thin-egress-app/blob/devel/NGAP-DEPLOY-README.MD)
showing how to add it to your deployment. Below are some Cumulus-specific tips:

### bucket_map.yaml

The Thin Egress App uses a `bucket_map.yaml` file to determine which buckets to
serve. Documentation of the file format is available [here](https://github.com/asfadmin/thin-egress-app#bucket-map).

A simple config, which would use the same URL scheme that we are using now,
would look something like this:

**bucket_map.yaml:**

```yaml
MAP:
  my-protected: my-protected
  my-public: my-public

PUBLIC_BUCKETS:
  - my-public
```

### Earthdata Login credentials

The Thin Egress App stores its Earthdata Login credentials in AWS Secrets
Manager. There are two values stored in the secret: `UrsId` and `UrsAuth`.

The `UrsId` is the URS client id. If you're unsure what that value is, it's
stored as `EARTHDATA_CLIENT_ID` in your `app/.env` file.

The value of `UrsAuth` is going to be your Earthdata Client ID joined to your
Earthdata Client password by a `:`, then base64-encoded. Your Earthdata Client
password is stored as `EARTHDATA_CLIENT_PASSWORD` in `app/.env`.

This is pretty confusing, so an example should help. Let's say that we're using
this `.env` file:

**app/.env:**

```shell
EARTHDATA_CLIENT_ID=my-client-id
EARTHDATA_CLIENT_PASSWORD=my-client-password
```

In this case, `UrsId` would be just "my-client-id".

`UrsAuth` would be be the output of running:

```shell
$ echo -n 'my-client-id:my-client-password' | base64
bXktY2xpZW50LWlkOm15LWNsaWVudC1wYXNzd29yZA==
```

?????? **Warning:** You must include the `-n` in the `echo` command. If you don't,
it will add a newline to the end of the string, which will give you an incorrect
base64 hash.

### Permissions boundaries

For NASA NGAP users, When storing the secret in Secrets Manager, and when
performing a Terraform deployment, you _must_ be run using `NGAPShNonProd`
credentials.

### Outputs

In addition to adding the Thin Egress App module, it is useful to configure the
TEA outputs as outputs of your Terraform deployment. That would look something
like this:

```hcl
output "tea_api_endpoint" {
  value = module.thin_egress_app.api_endpoint
}

output "tea_urs_redirect_uri" {
  value = module.thin_egress_app.urs_redirect_uri
}
```

Once you've run the Terraform deployment, you should get an output something
like this:

```text
tea_api_endpoint = https://abc123.execute-api.us-east-1.amazonaws.com/DEV/
tea_urs_redirect_uri = https://abc123.execute-api.us-east-1.amazonaws.com/DEV/login
```

Pass `api_distribution_url` to your `archive` module's `distribution_url` var.

You will also need to configure the `tea_urs_redirect_uri` value as a Redirect
URI in your app's URS configuration.

### Cumulus Configuration

The default Cumulus module generates a file at `s3://${system_bucket}/distribution_bucket_map.json`. If you've manually deployed TEA outside the `cumulus` module, you'll need to provide this configuration file as part of your Terraform deployment.

The configuration file is a simple json mapping of the form:

```json
{
  "daac-public-data-bucket": /path/to/this/kind/of/data
}
```

 **Please note: Cumulus only supports a one-to-one mapping of bucket->TEA path for 'distribution' buckets.**
