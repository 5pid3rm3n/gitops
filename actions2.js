const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const prettier = require('prettier');

async function generateInputsFromProperties(properties = {}, required = []) {
  return Object.entries(properties).map(([name, schema]) => {
    const isRequired = required.includes(name);
    return `      ${name}:
        description: '${schema.description || name}'
        required: ${isRequired}
        type: ${convertSwaggerTypeToWorkflowType(schema.type)}`;
  }).join('\n');
}

function convertSwaggerTypeToWorkflowType(swaggerType) {
  const typeMap = {
    'string': 'string',
    'integer': 'number',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'string', // Will be handled as JSON string
    'object': 'string'  // Will be handled as JSON string
  };
  return typeMap[swaggerType] || 'string';
}

async function generateWorkflow(operationId, method, pathUrl, operation) {
  let inputsContent = '';
  
  // Handle parameters
  const parameters = operation.parameters || [];
  const parameterInputs = parameters.map(param => {
    return `      ${param.name}:
        description: '${param.description || param.name}'
        required: ${param.required || false}
        type: string`;
  });

  // Handle request body properties
  if (operation.requestBody?.content?.['application/json']?.schema) {
    const schema = operation.requestBody.content['application/json'].schema;
    const properties = schema.properties || {};
    const required = schema.required || [];
    const bodyInputs = await generateInputsFromProperties(properties, required);
    if (bodyInputs) {
      inputsContent = [parameterInputs.join('\n'), bodyInputs].filter(Boolean).join('\n');
    }
  } else {
    inputsContent = parameterInputs.join('\n');
  }

  return `
name: ${operationId}

on:
  workflow_dispatch:
    inputs:
${inputsContent}

jobs:
  api-call:
    runs-on: ubuntu-latest
    steps:
      - name: Make API Request
        uses: fjogeleit/http-request-action@v1
        with:
          url: \${{ secrets.API_BASE_URL }}${pathUrl}
          method: ${method.toUpperCase()}
          customHeaders: '{"Content-Type": "application/json"}'
          bearerToken: \${{ secrets.API_TOKEN }}
          data: \${{ toJSON(inputs) }}
  `;
}

async function convertSwaggerToActions(swaggerPath) {
  const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
  const swagger = yaml.load(swaggerContent);
  
  const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  for (const [pathUrl, methods] of Object.entries(swagger.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const operationId = operation.operationId || `${method}-${pathUrl.replace(/\//g, '-')}`;
      
      const workflowContent = await generateWorkflow(operationId, method, pathUrl, operation);
      const formattedContent = await prettier.format(workflowContent, { parser: 'yaml' });
      
      const workflowPath = path.join(workflowsDir, `${operationId}.yml`);
      fs.writeFileSync(workflowPath, formattedContent);
    }
  }
}

const swaggerPath = process.argv[2] || 'swagger.yaml';
convertSwaggerToActions(swaggerPath).catch(console.error);