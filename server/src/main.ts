import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // l'API vit sous le chemin de son URL publique (sur Vercel : https://<domaine>/api, le préfixe n'est pas retiré)
  const prefix = new URL(app.get(ConfigService).getOrThrow<string>('APP_PUBLIC_URL')).pathname.replace(/^\/+|\/+$/g, '');
  if (prefix) app.setGlobalPrefix(prefix);
  // le front (autre port, ou autre sous-domaine en production) appelle l'API avec le cookie de session
  app.enableCors({ origin: process.env.CLIENT_PUBLIC_URL ?? "http://localhost:5173", credentials: true });
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
