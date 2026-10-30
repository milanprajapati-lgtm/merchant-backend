import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { MerchantApplication } from './merchant-application.entity';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { RISK_QUEUE } from '../risk/risk.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([MerchantApplication]),
    BullModule.registerQueue({ name: RISK_QUEUE }),
    UsersModule,
    AuditModule,
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
