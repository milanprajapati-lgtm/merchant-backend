import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApplicationsService } from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { ListApplicationsDto } from './dto/list-applications.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { DecisionDto } from './dto/decision.dto';
import { CurrentUser } from '../common/current-user.decorator';
import { RequestUser } from '../common/request-user';
import { RejectNullFieldsPipe } from '../common/reject-null-fields.pipe';
import { Roles } from '../common/roles.decorator';
import { UserRole } from '../users/user.entity';
import { presentApplication, presentPage } from './application.view';

// JwtAuthGuard and RolesGuard are registered globally (APP_GUARD in AppModule).
// Object-level rules (ownership, assignment) are enforced in ApplicationsService via ApplicationPolicy.
@ApiTags('applications')
@ApiBearerAuth()
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly service: ApplicationsService) {}

  @Post()
  @Roles(UserRole.SALES, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a DRAFT merchant application' })
  create(@Body() dto: CreateApplicationDto, @CurrentUser() user: RequestUser) {
    return this.service.create(dto, user).then((app) => presentApplication(app, user));
  }

  @Get()
  @ApiOperation({ summary: 'List applications visible to the caller (status filter + pagination)' })
  list(@Query() query: ListApplicationsDto, @CurrentUser() user: RequestUser) {
    return this.service.list(query, user).then((page) => presentPage(page, user));
  }

  @Get(':id')
  @ApiResponse({ status: 404, description: 'Not found, or not visible to the caller' })
  getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.service.getById(id, user).then((app) => presentApplication(app, user));
  }

  @Get(':id/audit')
  @Roles(UserRole.ADMIN, UserRole.REVIEWER)
  @ApiOperation({ summary: 'Audit trail for an application' })
  audit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.service.getAuditTrail(id, user);
  }

  @Patch(':id')
  @Roles(UserRole.SALES, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update an application while it is DRAFT or NEEDS_INFORMATION' })
  @ApiResponse({ status: 409, description: 'Application is not editable in its current status' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(RejectNullFieldsPipe) dto: UpdateApplicationDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.service.update(id, dto, user).then((app) => presentApplication(app, user));
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles(UserRole.SALES, UserRole.ADMIN)
  @ApiOperation({ summary: 'Submit for review and enqueue the asynchronous risk check' })
  @ApiResponse({ status: 202, description: 'Accepted; riskStatus is PENDING until the worker finishes' })
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser) {
    return this.service.submit(id, user).then((app) => presentApplication(app, user));
  }

  @Post(':id/assign-reviewer')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Assign (or reassign) a reviewer to a submitted application' })
  assignReviewer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignReviewerDto, @CurrentUser() user: RequestUser) {
    return this.service.assignReviewer(id, dto.reviewerId, user).then((app) => presentApplication(app, user));
  }

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REVIEWER)
  @ApiOperation({ summary: 'Approve / reject / request information (assigned reviewer only)' })
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecisionDto, @CurrentUser() user: RequestUser) {
    return this.service.decide(id, dto.decision, user, dto.note).then((app) => presentApplication(app, user));
  }
}
