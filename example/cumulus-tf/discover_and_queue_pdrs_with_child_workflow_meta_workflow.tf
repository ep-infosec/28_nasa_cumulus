module "discover_and_queue_pdrs_with_child_workflow_meta_workflow" {
  source = "../../tf-modules/workflow"

  prefix          = var.prefix
  name            = "DiscoverAndQueuePdrsChildWorkflowMeta"
  workflow_config = module.cumulus.workflow_config
  system_bucket   = var.system_bucket
  tags            = local.tags

  state_machine_definition = templatefile(
    "${path.module}/discover_and_queue_pdrs_with_child_workflow_meta_workflow.asl.json",
    {
      discover_pdrs_task_arn: module.cumulus.discover_pdrs_task.task_arn,
      parse_pdr_workflow_name: module.parse_pdr_workflow.name,
      queue_pdrs_task_arn: module.cumulus.queue_pdrs_task.task_arn,
      start_sf_queue_url: module.cumulus.start_sf_queue_url
    }
  )
}
