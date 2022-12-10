import { ApiPdr } from '@cumulus/types/api/pdrs';
import { invokeApi } from './cumulusApiClient';
import { ApiGatewayLambdaHttpProxyResponse, InvokeApiFunction } from './types';

/**
 * Delete a PDR via the Cumulus API
 *
 * @param {Object} params            - params
 * @param {string} params.prefix     - the prefix configured for the stack
 * @param {string} params.pdrName    - a PDR name
 * @param {Function} params.callback - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}        - the API response
 */
export const deletePdr = async (params: {
  prefix: string,
  pdrName: string,
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, pdrName, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'DELETE',
      resource: '/{proxy+}',
      path: `/pdrs/${pdrName}`,
    },
  });
};

/**
 * Fetch a PDR from the Cumulus API
 *
 * @param {Object} params            - params
 * @param {string} params.prefix     - the prefix configured for the stack
 * @param {string} params.pdrName    - a PDR name
 * @param {Function} params.callback - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}        - the PDR fetched by the API
 */
export const getPdr = async (params: {
  prefix: string,
  pdrName: string,
  callback?: InvokeApiFunction
}): Promise<ApiPdr> => {
  const { prefix, pdrName, callback = invokeApi } = params;

  const response = await callback({
    prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: `/pdrs/${pdrName}`,
    },
  });

  return JSON.parse(response.body);
};

/**
 * Fetch a list of pdrs from the Cumulus API
 *
 * @param {Object} params            - params
 * @param {string} params.prefix     - the prefix configured for the stack
 * @param {Function} params.callback - async function to invoke the api lambda
 *                                     that takes a prefix / user payload.  Defaults
 *                                     to cumulusApiClient.invokeApi
 * @returns {Promise<Object>}        - the pdr list fetched by the API
 */
export const getPdrs = async (params: {
  prefix: string,
  query?: {
    fields?: string[],
    [key: string]: string | string[] | undefined
  }
  callback?: InvokeApiFunction
}): Promise<ApiGatewayLambdaHttpProxyResponse> => {
  const { prefix, query, callback = invokeApi } = params;

  return await callback({
    prefix,
    payload: {
      httpMethod: 'GET',
      resource: '/{proxy+}',
      path: '/pdrs',
      queryStringParameters: query,
    },
  });
};
