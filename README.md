# 🌟 Swagger to GitHub Actions Converter 🌟

A Node.js tool that automatically converts OpenAPI/Swagger specifications into GitHub Actions workflows. Each API endpoint is converted into a separate workflow file with appropriate inputs and configuration.

## ✨ Features

- 🚀 Converts OpenAPI/Swagger endpoints to GitHub Actions workflows
- 🔄 Handles complex schema references and nested objects
- 📚 Supports array types and oneOf schemas
- ✅ Preserves parameter requirements and validations
- 🎨 Includes enum values in input descriptions
- 🛠️ Properly formats path parameters
- 📋 Generates standardized API call workflows

## 📦 Installation

```bash
# Clone the repository
git clone <repository-url>

# Install dependencies
npm install
```

## Usage

```bash
node swag_to_github_actions.js path/to/swagger.yaml
```

The script will:

- Read the Swagger/OpenAPI specification
- Generate workflow files in .github/workflows/
- Create one workflow per API endpoint

## Input Handling

The converter handles various input types:

- Path parameters
- Query parameters
- Request body properties
- Nested objects
- Array types
- Enum values
- Required fields

## Generated Workflow Structure

Each generated workflow includes:

- Unique name based on operationId
- Manual trigger (workflow_dispatch)
- Inputs based on API parameters
- HTTP request action
- Response handling

Example:

```yaml
name: example-workflow
on: workflow_dispatch
jobs:
  example-job:
    runs-on: ubuntu-latest
    steps:
      - name: Make API Request
        run: |
          curl -X GET "https://api.example.com/endpoint" \
          -H "Authorization: Bearer ${{ secrets.API_TOKEN }}"
```

## Configuration

The converter requires:

- API_BASE_URL secret in GitHub repository
- API_TOKEN secret for authentication
- Valid OpenAPI/Swagger specification file

## Supported OpenAPI Features

- Schema references ($ref)
- Array types
- Nested objects
- oneOf schemas
- Required fields
- Enum values
- Parameter descriptions
- Path parameters
- Request body schemas

## Error Handling

The converter includes:

- Reference resolution warnings
- Schema validation
- Error logging
- Fallback types
- Missing parameter handling

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request

## Known Issues

Currently, the following files have issues with the conversion:
- get--api-v1-organization-roles.yml
- get--api-v1-organization.yml
- get--api-v1-tasks.yml
- post--api-v1-deployment-plan.yml
- post--api-v1-deployments-{deploymentId}-files.yml
- post--api-v1-deployments-approve.yml
- post--api-v1-deployments-archive.yml
- post--api-v1-deployments-cancel.yml
- post--api-v1-deployments-unarchive.yml
- post--api-v1-package.yml
- post--api-v1-rescue-tf-extract.yml