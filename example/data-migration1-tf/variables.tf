variable "prefix" {
  type = string
}

variable "data_persistence_remote_state_config" {
  type = object({ bucket = string, key = string, region = string })
}

variable "provider_kms_key_id" {
  type = string
}

# Optional

variable "lambda_subnet_ids" {
  type = list(string)
  default = []
}

variable "permissions_boundary_arn" {
  type    = string
  default = null
}
variable "rds_connection_timing_configuration" {
  description = "Cumulus rds connection timeout retry timing object -- these values map to knex.js's internal use of  https://github.com/vincit/tarn.js/ for connection acquisition"
  type = map(number)
  default = {
      acquireTimeoutMillis: 90000
      createRetryIntervalMillis: 30000,
      createTimeoutMillis: 20000,
      idleTimeoutMillis: 1000,
      reapIntervalMillis: 1000,
  }
}


variable "region" {
  type    = string
  default = "us-east-1"
}

variable "tags" {
  description = "Tags to be applied to Cumulus resources that support tags"
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  type    = string
  default = null
}
