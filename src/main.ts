import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // JSON-only API, so a CSP adds nothing; the other helmet defaults (HSTS, nosniff, frame options...) stay on.
  app.use(helmet({ contentSecurityPolicy: false }));
  configureApp(app);
  app.enableShutdownHooks();

  // Interactive docs are a development aid; don't publish the API surface from production.
  if (process.env.NODE_ENV !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Merchant Operations API')
      .setDescription('Merchant onboarding and risk review API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
