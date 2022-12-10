module "lzards_backup_fail_workflow" {
    source = "../../tf-modules/workflow/"

    prefix          = var.prefix 
    name            = "LzardsBackupFailTest"
    workflow_config = module.cumulus.workflow_config
    system_bucket   = var.system_bucket
    tags            = local.tags

  state_machine_definition = templatefile(
    "${path.module}/lzards_backup_fail_workflow.asl.json",
    {
      lzards_backup_task_arn: module.cumulus.lzards_backup_task.task_arn
    }
  )
}
