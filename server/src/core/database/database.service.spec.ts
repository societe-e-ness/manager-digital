import { Test, TestingModule } from "@nestjs/testing";
import { DatabaseService } from "./database.service";

describe("DatabaseService", () => {
  let service: DatabaseService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DatabaseService],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  afterAll(async () => {
    await service.$disconnect();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  it("should call the User model without problem", async () => {
    const users = await service.user.findMany();
    expect(users).toBeDefined();
  });

  it("should create a new user", async () => {
    const randomId = Math.floor(Math.random() * 10000);
    const user = { email: `test${randomId}@test.com`, name: `test${randomId}` };
    const result = await service.user.create({ data: user });

    expect(result).toMatchObject(user);
  });
});
