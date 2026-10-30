import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuditModule } from '../audit/audit.module';
import { RiskProcessor } from './risk.processor';
import { RiskReconciler } from './risk.reconciler';
import { RISK_PROVIDER, SimulatedKybProvider } from './risk-provider';
import { RISK_QUEUE } from './risk.constants';

@Module({
  imports: [BullModule.registerQueue({ name: RISK_QUEUE }), AuditModule],
  providers: [RiskProcessor, RiskReconciler, { provide: RISK_PROVIDER, useClass: SimulatedKybProvider }],
})
export class RiskModule {}
