#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { MakerbayStack } from '../lib/makerbay-stack'

const app = new cdk.App()
new MakerbayStack(app, 'Makerbay', {
  env: { account: '953146692138', region: 'us-east-1' },
})
