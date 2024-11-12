const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const prettier = require('prettier');

function resolveSchemaRef(schema, components = {}) {
  if (!schema) return {};
  
  if (schema.$ref) {
    try {
      const refPath = schema.$ref.replace('#/', '').split('/');
      let resolved = components;
      for (const part of refPath) {
        resolved = resolved?.[part];
        if (!resolved) {
          console.warn(`Warning: Could not resolve reference ${schema.$ref}`);
          return {};
        }
      }
      return resolved;
    } catch (error) {
      console.warn(`Warning: Error resolving reference: ${error.message}`);
      return {};
    }
  }

  if (schema.type === 'array' && schema.items) {
    const resolvedItems = resolveSchemaRef(schema.items, components);
    return {
      type: 'array',
      items: resolvedItems,
      properties: resolvedItems.properties || {}
    };
  }

  return schema;
}

function extractSchemaProperties(requestBody, components) {
  if (!requestBody?.content?.['application/json']?.schema) {
    return { properties: {}, required: [] };
  }

  const schema = resolveSchemaRef(requestBody.content['application/json'].schema, components);
  const required = schema.required || [];

  if (schema.type === 'array' && schema.items?.oneOf) {
    return extractArrayItemProperties(schema);
  }

  if (schema.oneOf) {
    return processOneOfSchemas(schema.oneOf);
  }

  if (schema.properties) {
    return {
      properties: Object.entries(schema.properties).reduce((acc, [key, prop]) => {
        const enumValues = prop.enum ? ` (${prop.enum.join(', ')})` : '';
        acc[key] = {
          ...prop,
          description: `${prop.description || key}${enumValues}`,
          required: required.includes(key)
        };
        return acc;
      }, {}),
      required
    };
  }

  return { properties: {}, required: [] };
}

function extractArrayItemProperties(schema) {
  const allProperties = {};
  const allRequired = new Set();

  schema.items.oneOf.forEach(variant => {
    if (variant.type === 'object') {
      const { properties, required } = extractNestedProperties(variant);
      Object.entries(properties).forEach(([key, value]) => {
        allProperties[key] = value;
      });
      required.forEach(req => allRequired.add(req));
    }
  });

  return {
    properties: allProperties,
    required: Array.from(allRequired)
  };
}

function extractNestedProperties(schema, prefix = '') {
  let properties = {};
  let required = [];

  if (schema.type === 'object' && schema.properties) {
    Object.entries(schema.properties).forEach(([key, prop]) => {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      if (prop.type === 'object' && prop.properties) {
        const nested = extractNestedProperties(prop, fullKey);
        properties = { ...properties, ...nested.properties };
        required = [...required, ...nested.required.map(r => `${fullKey}.${r}`)];
      } else {
        properties[fullKey] = prop;
        if (schema.required?.includes(key)) {
          required.push(fullKey);
        }
      }
    });
  }

  return { properties, required };
}

function processOneOfSchemas(oneOfSchemas) {
  const allProperties = {};
  const allRequired = new Set();

  oneOfSchemas.forEach(schema => {
    if (schema.properties) {
      Object.entries(schema.properties).forEach(([key, value]) => {
        allProperties[key] = value;
      });
    }
    if (schema.required) {
      schema.required.forEach(field => allRequired.add(field));
    }
  });

  return {
    properties: allProperties,
    required: Array.from(allRequired)
  };
}

function convertSwaggerTypeToWorkflowType(swaggerType) {
  const typeMap = {
    'string': 'string',
    'integer': 'number',
    'number': 'number',
    'boolean': 'boolean',
    'array': 'string',
    'object': 'string'
  };
  return typeMap[swaggerType] || 'string';
}

async function generateInputsFromProperties(properties = {}, required = [], components = {}) {
  if (!properties || typeof properties !== 'object') {
    return '';
  }

  return Object.entries(properties).map(([name, schema]) => {
    const isRequired = Array.isArray(required) && required.includes(name);
    const description = schema.description || 
                       (schema.enum ? `${name} (${schema.enum.join(', ')})` : name);
    
    return `      ${name}:
        description: '${description}'
        required: ${isRequired}
        type: ${convertSwaggerTypeToWorkflowType(schema.type)}`;
  }).join('\n');
}

function replacePathParameters(pathUrl) {
  return pathUrl.replace(/{([^}]+)}/g, (match, param) => {
    return `\${{ inputs.${param} }}`;
  });
}

async function generateWorkflow(operationId, method, pathUrl, operation, swagger) {
  let inputsContent = '';
  
  const parameters = operation.parameters || [];
  const parameterInputs = parameters.map(param => {
    const resolvedParam = resolveSchemaRef(param.schema, swagger.components);
    return `      ${param.name}:
        description: '${param.description || param.name}'
        required: ${param.required || false}
        type: ${convertSwaggerTypeToWorkflowType(resolvedParam.type)}`;
  });

  if (operation.requestBody) {
    const { properties, required } = extractSchemaProperties(operation.requestBody, swagger.components);
    const bodyInputs = await generateInputsFromProperties(properties, required, swagger.components);
    if (bodyInputs) {
      inputsContent = [parameterInputs.join('\n'), bodyInputs].filter(Boolean).join('\n');
    }
  } else {
    inputsContent = parameterInputs.join('\n');
  }

  const formattedPath = replacePathParameters(pathUrl);

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
        id: api-request
        uses: fjogeleit/http-request-action@v1
        with:
          url: \${{ secrets.API_BASE_URL }}${formattedPath}
          method: ${method.toUpperCase()}
          customHeaders: '{"Content-Type": "application/json"}'
          bearerToken: \${{ secrets.API_TOKEN }}
          data: \${{ toJSON(inputs) }}
      
      - name: Response
        run: echo \${{ toJSON(steps.api-request.outputs.response) }} | jq .
  `;
}

async function convertSwaggerToActions(swaggerPath) {
  try {
    const swaggerContent = fs.readFileSync(swaggerPath, 'utf8');
    const swagger = yaml.load(swaggerContent) || {};
    
    if (!swagger.paths) {
      throw new Error('No paths found in Swagger specification');
    }

    const workflowsDir = path.join(process.cwd(), '.github', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    for (const [pathUrl, methods] of Object.entries(swagger.paths)) {
      for (const [method, operation] of Object.entries(methods || {})) {
        if (!operation) continue;

        const operationId = operation.operationId || `${method}-${pathUrl.replace(/\//g, '-')}`;
        
        const workflowContent = await generateWorkflow(operationId, method, pathUrl, operation, swagger);
        const formattedContent = await prettier.format(workflowContent, { parser: 'yaml' });
        
        const workflowPath = path.join(workflowsDir, `${operationId}.yml`);
        fs.writeFileSync(workflowPath, formattedContent);
      }
    }
  } catch (error) {
    console.error(`Error converting Swagger to Actions: ${error.message}`);
    throw error;
  }
}

const swaggerPath = process.argv[2] || 'swagger.yaml';
convertSwaggerToActions(swaggerPath).catch(console.error);