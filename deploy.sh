#!/usr/bin/env bash
# deploy.sh — Deploy futarchy-twap as AWS Lambda + API Gateway
#
# Usage:
#   1. Copy this file and fill in the CONFIG section below
#   2. Run: aws configure  (set your credentials + region)
#   3. Run: bash deploy.sh
#
# Requirements:
#   - AWS CLI v2 installed and configured
#   - IAM permissions: lambda:*, apigatewayv2:*, acm:*, route53:*
#   - An existing Lambda execution role (or iam:CreateRole permission)
#   - A Route 53 hosted zone for your domain

set -e

# ─── CONFIG (edit these) ─────────────────────────────────────────────────────
REGION="eu-north-1"                    # AWS region to deploy to
FUNCTION_NAME="futarchy-twap"          # Lambda function name
API_NAME="futarchy-twap-api"           # API Gateway name
DOMAIN_NAME="api.example.com"          # Your custom domain (e.g. api.futarchy.fi)
HOSTED_ZONE_DOMAIN="example.com"       # Root domain in Route 53 (e.g. futarchy.fi)
ROLE_ARN=""                            # Existing Lambda execution role ARN
                                       # e.g. arn:aws:iam::123456789:role/service-role/my-lambda-role
                                       # Leave empty to auto-create (requires iam:CreateRole)
ROLE_NAME="futarchy-twap-lambda-role"  # Only used if ROLE_ARN is empty
ZIP_FILE="/tmp/futarchy-twap.zip"
RUNTIME="nodejs18.x"
HANDLER="lambda.handler"
TIMEOUT=30    # seconds
MEMORY=512    # MB
# ─────────────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       futarchy-twap Lambda Deployment                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Check AWS CLI ────────────────────────────────────────────────────────────
echo "▶ Checking AWS CLI..."
aws --version

# ─── Check credentials ───────────────────────────────────────────────────────
echo ""
echo "▶ Checking AWS credentials..."
aws sts get-caller-identity --region $REGION
echo "  ✓ Credentials OK"

# ─── IAM Role ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Setting up IAM role..."
if [ -z "$ROLE_ARN" ]; then
    ROLE_ARN=$(aws iam get-role --role-name $ROLE_NAME --query 'Role.Arn' --output text 2>/dev/null || true)
    if [ -z "$ROLE_ARN" ]; then
        echo "  Creating role $ROLE_NAME..."
        ROLE_ARN=$(aws iam create-role \
            --role-name $ROLE_NAME \
            --assume-role-policy-document '{
                "Version": "2012-10-17",
                "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
            }' \
            --query 'Role.Arn' --output text)
        aws iam attach-role-policy \
            --role-name $ROLE_NAME \
            --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
        echo "  Waiting for role to propagate..."
        sleep 10
    fi
fi
echo "  ✓ Role ARN: $ROLE_ARN"

# ─── Package Lambda ───────────────────────────────────────────────────────────
echo ""
echo "▶ Packaging Lambda..."
rm -f $ZIP_FILE
cd "$(dirname "$0")"
zip -r $ZIP_FILE lambda.js lib/ node_modules/ package.json -x "*.git*" > /dev/null
echo "  ✓ Package: $ZIP_FILE ($(du -sh $ZIP_FILE | cut -f1))"

# ─── Deploy Lambda ────────────────────────────────────────────────────────────
echo ""
echo "▶ Deploying Lambda function: $FUNCTION_NAME..."
EXISTING=$(aws lambda get-function --function-name $FUNCTION_NAME --region $REGION \
    --query 'Configuration.FunctionArn' --output text 2>/dev/null || true)

if [ -z "$EXISTING" ]; then
    LAMBDA_ARN=$(aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime $RUNTIME \
        --role $ROLE_ARN \
        --handler $HANDLER \
        --zip-file fileb://$ZIP_FILE \
        --timeout $TIMEOUT \
        --memory-size $MEMORY \
        --region $REGION \
        --query 'FunctionArn' --output text)
else
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://$ZIP_FILE \
        --region $REGION > /dev/null
    LAMBDA_ARN=$EXISTING
    aws lambda wait function-updated --function-name $FUNCTION_NAME --region $REGION
fi
echo "  ✓ Lambda ARN: $LAMBDA_ARN"

# ─── API Gateway ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Setting up API Gateway..."
API_ID=$(aws apigatewayv2 get-apis --region $REGION \
    --query "Items[?Name=='$API_NAME'].ApiId" --output text 2>/dev/null || true)

if [ -z "$API_ID" ]; then
    API_ID=$(aws apigatewayv2 create-api \
        --name $API_NAME \
        --protocol-type HTTP \
        --cors-configuration AllowOrigins='*',AllowMethods='GET,OPTIONS',AllowHeaders='Content-Type' \
        --region $REGION \
        --query 'ApiId' --output text)
fi
echo "  ✓ API ID: $API_ID"

INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id $API_ID --region $REGION \
    --query "Items[?IntegrationUri=='$LAMBDA_ARN'].IntegrationId" --output text 2>/dev/null || true)
if [ -z "$INTEGRATION_ID" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration \
        --api-id $API_ID \
        --integration-type AWS_PROXY \
        --integration-uri $LAMBDA_ARN \
        --payload-format-version 2.0 \
        --region $REGION \
        --query 'IntegrationId' --output text)
fi

ROUTE_EXISTS=$(aws apigatewayv2 get-routes --api-id $API_ID --region $REGION \
    --query "Items[?RouteKey=='ANY /{proxy+}'].RouteId" --output text 2>/dev/null || true)
if [ -z "$ROUTE_EXISTS" ]; then
    aws apigatewayv2 create-route --api-id $API_ID --route-key 'ANY /{proxy+}' \
        --target "integrations/$INTEGRATION_ID" --region $REGION > /dev/null
    aws apigatewayv2 create-route --api-id $API_ID --route-key 'ANY /' \
        --target "integrations/$INTEGRATION_ID" --region $REGION > /dev/null 2>&1 || true
fi

STAGE_EXISTS=$(aws apigatewayv2 get-stages --api-id $API_ID --region $REGION \
    --query "Items[?StageName=='\$default'].StageName" --output text 2>/dev/null || true)
if [ -z "$STAGE_EXISTS" ]; then
    aws apigatewayv2 create-stage --api-id $API_ID --stage-name '$default' \
        --auto-deploy --region $REGION > /dev/null
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws lambda add-permission \
    --function-name $FUNCTION_NAME \
    --statement-id "apigateway-invoke-$(date +%s)" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT_ID:$API_ID/*" \
    --region $REGION > /dev/null 2>&1 || true

API_ENDPOINT="https://${API_ID}.execute-api.${REGION}.amazonaws.com"
echo "  ✓ API endpoint: $API_ENDPOINT"

# ─── ACM Certificate ─────────────────────────────────────────────────────────
echo ""
echo "▶ Requesting ACM certificate for $DOMAIN_NAME..."
CERT_ARN=$(aws acm list-certificates --region $REGION \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN_NAME'].CertificateArn" \
    --output text 2>/dev/null || true)

if [ -z "$CERT_ARN" ]; then
    CERT_ARN=$(aws acm request-certificate \
        --domain-name $DOMAIN_NAME \
        --validation-method DNS \
        --region $REGION \
        --query 'CertificateArn' --output text)
    sleep 5
    VALIDATION=$(aws acm describe-certificate --certificate-arn $CERT_ARN \
        --region $REGION --query 'Certificate.DomainValidationOptions[0].ResourceRecord')
    CNAME_NAME=$(echo $VALIDATION | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Name'])")
    CNAME_VALUE=$(echo $VALIDATION | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Value'])")
    HOSTED_ZONE_ID=$(aws route53 list-hosted-zones \
        --query "HostedZones[?Name=='${HOSTED_ZONE_DOMAIN}.'].Id" \
        --output text | sed 's|/hostedzone/||')
    aws route53 change-resource-record-sets --hosted-zone-id $HOSTED_ZONE_ID \
        --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$CNAME_NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$CNAME_VALUE\"}]}}]}" > /dev/null
    echo "  Waiting for certificate validation (1-5 min)..."
    aws acm wait certificate-validated --certificate-arn $CERT_ARN --region $REGION
fi
echo "  ✓ Certificate: $CERT_ARN"

# ─── Custom Domain ────────────────────────────────────────────────────────────
echo ""
echo "▶ Setting up custom domain: $DOMAIN_NAME..."
DOMAIN_EXISTS=$(aws apigatewayv2 get-domain-names --region $REGION \
    --query "Items[?DomainName=='$DOMAIN_NAME'].DomainName" --output text 2>/dev/null || true)

if [ -z "$DOMAIN_EXISTS" ]; then
    DOMAIN_INFO=$(aws apigatewayv2 create-domain-name \
        --domain-name $DOMAIN_NAME \
        --domain-name-configurations CertificateArn=$CERT_ARN,EndpointType=REGIONAL \
        --region $REGION)
else
    DOMAIN_INFO=$(aws apigatewayv2 get-domain-name --domain-name $DOMAIN_NAME --region $REGION)
fi

API_GW_DOMAIN=$(echo $DOMAIN_INFO | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['DomainNameConfigurations'][0]['ApiGatewayDomainName'])")
API_GW_HOSTED_ZONE=$(echo $DOMAIN_INFO | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['DomainNameConfigurations'][0]['HostedZoneId'])")

MAPPING_EXISTS=$(aws apigatewayv2 get-api-mappings --domain-name $DOMAIN_NAME --region $REGION \
    --query "Items[?ApiId=='$API_ID'].ApiMappingId" --output text 2>/dev/null || true)
if [ -z "$MAPPING_EXISTS" ]; then
    aws apigatewayv2 create-api-mapping --domain-name $DOMAIN_NAME \
        --api-id $API_ID --stage '$default' --region $REGION > /dev/null
fi

# ─── Route 53 ────────────────────────────────────────────────────────────────
echo ""
echo "▶ Updating Route 53: $DOMAIN_NAME → API Gateway..."
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones \
    --query "HostedZones[?Name=='${HOSTED_ZONE_DOMAIN}.'].Id" \
    --output text | sed 's|/hostedzone/||')
aws route53 change-resource-record-sets --hosted-zone-id $HOSTED_ZONE_ID \
    --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$DOMAIN_NAME\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"$API_GW_HOSTED_ZONE\",\"DNSName\":\"$API_GW_DOMAIN\",\"EvaluateTargetHealth\":false}}}]}" > /dev/null
echo "  ✓ Route 53 updated"

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║                  ✅ Deployment Complete!             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Direct endpoint: $API_ENDPOINT"
echo "  Custom domain:   https://$DOMAIN_NAME  (DNS may take 1-2 min)"
echo ""
echo "  Test:"
echo "    curl https://$DOMAIN_NAME/health"
echo "    curl https://$DOMAIN_NAME/pools/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc"
echo "    curl \"https://$DOMAIN_NAME/twap/100/0x45e1064348fd8a407d6d1f59fc64b05f633b28fc?days=5\""
echo ""
