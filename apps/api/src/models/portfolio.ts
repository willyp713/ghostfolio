import { AccountService } from '@ghostfolio/api/app/account/account.service';
import { CashDetails } from '@ghostfolio/api/app/account/interfaces/cash-details.interface';
import { UNKNOWN_KEY, ghostfolioCashSymbol } from '@ghostfolio/common/config';
import {
  DATE_FORMAT,
  getToday,
  getYesterday,
  resetHours
} from '@ghostfolio/common/helper';
import {
  PortfolioItem,
  PortfolioPerformance,
  PortfolioPosition,
  PortfolioReport,
  Position,
  UserWithSettings
} from '@ghostfolio/common/interfaces';
import { Country } from '@ghostfolio/common/interfaces/country.interface';
import { Sector } from '@ghostfolio/common/interfaces/sector.interface';
import { DateRange, OrderWithAccount } from '@ghostfolio/common/types';
import { Currency, Prisma } from '@prisma/client';
import { continents, countries } from 'countries-list';
import {
  add,
  format,
  getDate,
  getMonth,
  getYear,
  isAfter,
  isBefore,
  isSameDay,
  isToday,
  isYesterday,
  parseISO,
  setDate,
  setMonth,
  sub
} from 'date-fns';
import { cloneDeep, isEmpty } from 'lodash';
import * as roundTo from 'round-to';

import { DataProviderService } from '../services/data-provider.service';
import { ExchangeRateDataService } from '../services/exchange-rate-data.service';
import { IOrder, MarketState, Type } from '../services/interfaces/interfaces';
import { RulesService } from '../services/rules.service';
import { PortfolioInterface } from './interfaces/portfolio.interface';
import { Order } from './order';
import { OrderType } from './order-type';
import { AccountClusterRiskCurrentInvestment } from './rules/account-cluster-risk/current-investment';
import { AccountClusterRiskInitialInvestment } from './rules/account-cluster-risk/initial-investment';
import { AccountClusterRiskSingleAccount } from './rules/account-cluster-risk/single-account';
import { CurrencyClusterRiskBaseCurrencyCurrentInvestment } from './rules/currency-cluster-risk/base-currency-current-investment';
import { CurrencyClusterRiskBaseCurrencyInitialInvestment } from './rules/currency-cluster-risk/base-currency-initial-investment';
import { CurrencyClusterRiskCurrentInvestment } from './rules/currency-cluster-risk/current-investment';
import { CurrencyClusterRiskInitialInvestment } from './rules/currency-cluster-risk/initial-investment';
import { FeeRatioInitialInvestment } from './rules/fees/fee-ratio-initial-investment';

export class Portfolio implements PortfolioInterface {
  private orders: Order[] = [];
  private portfolioItems: PortfolioItem[] = [];
  private user: UserWithSettings;

  public constructor(
    private accountService: AccountService,
    private dataProviderService: DataProviderService,
    private exchangeRateDataService: ExchangeRateDataService,
    private rulesService: RulesService
  ) {}

  public async addCurrentPortfolioItems() {
    const currentData = await this.dataProviderService.get(this.getSymbols());

    const currentDate = new Date();

    const year = getYear(currentDate);
    const month = getMonth(currentDate);
    const day = getDate(currentDate);

    const today = new Date(Date.UTC(year, month, day));
    const yesterday = getYesterday();

    const [portfolioItemsYesterday] = this.get(yesterday);

    const positions: { [symbol: string]: Position } = {};

    this.getSymbols().forEach((symbol) => {
      positions[symbol] = {
        symbol,
        averagePrice: portfolioItemsYesterday?.positions[symbol]?.averagePrice,
        currency: portfolioItemsYesterday?.positions[symbol]?.currency,
        firstBuyDate: portfolioItemsYesterday?.positions[symbol]?.firstBuyDate,
        investment: portfolioItemsYesterday?.positions[symbol]?.investment,
        investmentInOriginalCurrency:
          portfolioItemsYesterday?.positions[symbol]
            ?.investmentInOriginalCurrency,
        marketPrice:
          currentData[symbol]?.marketPrice ??
          portfolioItemsYesterday.positions[symbol]?.marketPrice,
        quantity: portfolioItemsYesterday?.positions[symbol]?.quantity,
        transactionCount:
          portfolioItemsYesterday?.positions[symbol]?.transactionCount
      };
    });

    if (portfolioItemsYesterday?.investment) {
      const portfolioItemsLength = this.portfolioItems.push(
        cloneDeep({
          date: today.toISOString(),
          grossPerformancePercent: 0,
          investment: portfolioItemsYesterday?.investment,
          positions: positions,
          value: 0
        })
      );

      // Set value after pushing today's portfolio items
      this.portfolioItems[portfolioItemsLength - 1].value =
        this.getValue(today);
    }

    return this;
  }

  public async addFuturePortfolioItems() {
    let investment = this.getInvestment(new Date());

    this.getOrders()
      .filter((order) => order.getIsDraft() === true)
      .forEach((order) => {
        investment += this.exchangeRateDataService.toCurrency(
          order.getTotal(),
          order.getCurrency(),
          this.user.Settings.currency
        );

        const portfolioItem = this.portfolioItems.find((item) => {
          return item.date === order.getDate();
        });

        if (portfolioItem) {
          portfolioItem.investment = investment;
        } else {
          this.portfolioItems.push({
            investment,
            date: order.getDate(),
            grossPerformancePercent: 0,
            positions: {},
            value: 0
          });
        }
      });

    return this;
  }

  public createFromData({
    orders,
    portfolioItems,
    user
  }: {
    orders: IOrder[];
    portfolioItems: PortfolioItem[];
    user: UserWithSettings;
  }): Portfolio {
    orders.forEach(
      ({
        account,
        currency,
        fee,
        date,
        id,
        quantity,
        symbol,
        symbolProfile,
        type,
        unitPrice
      }) => {
        this.orders.push(
          new Order({
            account,
            currency,
            fee,
            date,
            id,
            quantity,
            symbol,
            symbolProfile,
            type,
            unitPrice
          })
        );
      }
    );

    portfolioItems.forEach(
      ({ date, grossPerformancePercent, investment, positions, value }) => {
        this.portfolioItems.push({
          date,
          grossPerformancePercent,
          investment,
          positions,
          value
        });
      }
    );

    this.setUser(user);

    return this;
  }

  public get(aDate?: Date): PortfolioItem[] {
    if (aDate) {
      const filteredPortfolio = this.portfolioItems.find((item) => {
        return isSameDay(aDate, new Date(item.date));
      });

      if (filteredPortfolio) {
        return [cloneDeep(filteredPortfolio)];
      }

      return [];
    }

    return cloneDeep(this.portfolioItems);
  }

  public getCommittedFunds() {
    return this.getTotalBuy() - this.getTotalSell();
  }

  public async getDetails(
    aDateRange: DateRange = 'max'
  ): Promise<{ [symbol: string]: PortfolioPosition }> {
    const dateRangeDate = this.convertDateRangeToDate(
      aDateRange,
      this.getMinDate()
    );

    const [portfolioItemsBefore] = this.get(dateRangeDate);

    const [portfolioItemsNow] = await this.get(new Date());

    const cashDetails = await this.accountService.getCashDetails(
      this.user.id,
      this.user.Settings.currency
    );
    const investment = this.getInvestment(new Date()) + cashDetails.balance;
    const portfolioItems = this.get(new Date());
    const symbols = this.getSymbols(new Date());
    const value = this.getValue() + cashDetails.balance;

    const details: { [symbol: string]: PortfolioPosition } = {};

    const data = await this.dataProviderService.get(symbols);

    symbols.forEach((symbol) => {
      const accounts: PortfolioPosition['accounts'] = {};
      let countriesOfSymbol: Country[];
      let sectorsOfSymbol: Sector[];
      const [portfolioItem] = portfolioItems;

      const ordersBySymbol = this.getOrders().filter((order) => {
        return order.getSymbol() === symbol;
      });

      ordersBySymbol.forEach((orderOfSymbol) => {
        let currentValueOfSymbol = this.exchangeRateDataService.toCurrency(
          orderOfSymbol.getQuantity() *
            portfolioItemsNow.positions[symbol].marketPrice,
          orderOfSymbol.getCurrency(),
          this.user.Settings.currency
        );
        let originalValueOfSymbol = this.exchangeRateDataService.toCurrency(
          orderOfSymbol.getQuantity() * orderOfSymbol.getUnitPrice(),
          orderOfSymbol.getCurrency(),
          this.user.Settings.currency
        );

        if (orderOfSymbol.getType() === 'SELL') {
          currentValueOfSymbol *= -1;
          originalValueOfSymbol *= -1;
        }

        if (
          accounts[orderOfSymbol.getAccount()?.name || UNKNOWN_KEY]?.current
        ) {
          accounts[orderOfSymbol.getAccount()?.name || UNKNOWN_KEY].current +=
            currentValueOfSymbol;
          accounts[orderOfSymbol.getAccount()?.name || UNKNOWN_KEY].original +=
            originalValueOfSymbol;
        } else {
          accounts[orderOfSymbol.getAccount()?.name || UNKNOWN_KEY] = {
            current: currentValueOfSymbol,
            original: originalValueOfSymbol
          };
        }

        countriesOfSymbol = (
          (orderOfSymbol.getSymbolProfile()?.countries as Prisma.JsonArray) ??
          []
        ).map((country) => {
          const { code, weight } = country as Prisma.JsonObject;

          return {
            code: code as string,
            continent:
              continents[countries[code as string]?.continent] ?? UNKNOWN_KEY,
            name: countries[code as string]?.name ?? UNKNOWN_KEY,
            weight: weight as number
          };
        });

        sectorsOfSymbol = (
          (orderOfSymbol.getSymbolProfile()?.sectors as Prisma.JsonArray) ?? []
        ).map((sector) => {
          const { name, weight } = sector as Prisma.JsonObject;

          return {
            name: (name as string) ?? UNKNOWN_KEY,
            weight: weight as number
          };
        });
      });

      let now = portfolioItemsNow.positions[symbol].marketPrice;

      // 1d
      let before = portfolioItemsBefore?.positions[symbol].marketPrice;

      if (aDateRange === 'ytd') {
        before =
          portfolioItemsBefore.positions[symbol].marketPrice ||
          portfolioItemsNow.positions[symbol].averagePrice;
      } else if (
        aDateRange === '1y' ||
        aDateRange === '5y' ||
        aDateRange === 'max'
      ) {
        before = portfolioItemsNow.positions[symbol].averagePrice;
      }

      if (
        !isBefore(
          parseISO(portfolioItemsNow.positions[symbol].firstBuyDate),
          parseISO(portfolioItemsBefore?.date)
        )
      ) {
        // Trade was not before the date of portfolioItemsBefore, then override it with average price
        // (e.g. on same day)
        before = portfolioItemsNow.positions[symbol].averagePrice;
      }

      if (isToday(parseISO(portfolioItemsNow.positions[symbol].firstBuyDate))) {
        now = portfolioItemsNow.positions[symbol].averagePrice;
      }

      details[symbol] = {
        ...data[symbol],
        accounts,
        symbol,
        allocationCurrent:
          this.exchangeRateDataService.toCurrency(
            portfolioItem.positions[symbol].quantity * now,
            data[symbol]?.currency,
            this.user.Settings.currency
          ) / value,
        allocationInvestment:
          portfolioItem.positions[symbol].investment / investment,
        countries: countriesOfSymbol,
        grossPerformance: roundTo(
          portfolioItemsNow.positions[symbol].quantity * (now - before),
          2
        ),
        grossPerformancePercent: roundTo((now - before) / before, 4),
        investment: portfolioItem.positions[symbol].investment,
        quantity: portfolioItem.positions[symbol].quantity,
        sectors: sectorsOfSymbol,
        transactionCount: portfolioItem.positions[symbol].transactionCount,
        value: this.exchangeRateDataService.toCurrency(
          portfolioItem.positions[symbol].quantity * now,
          data[symbol]?.currency,
          this.user.Settings.currency
        )
      };
    });

    details[ghostfolioCashSymbol] = await this.getCashPosition({
      cashDetails,
      investment,
      value
    });

    return details;
  }

  public getFees(aDate = new Date(0)) {
    return this.orders
      .filter((order) => {
        // Filter out all orders before given date
        return isBefore(aDate, new Date(order.getDate()));
      })
      .map((order) => {
        return this.exchangeRateDataService.toCurrency(
          order.getFee(),
          order.getCurrency(),
          this.user.Settings.currency
        );
      })
      .reduce((previous, current) => previous + current, 0);
  }

  public getInvestment(aDate: Date): number {
    return this.get(aDate)[0]?.investment || 0;
  }

  public getMinDate() {
    const orders = this.getOrders().filter(
      (order) => order.getIsDraft() === false
    );

    if (orders.length > 0) {
      return new Date(this.orders[0].getDate());
    }

    return null;
  }

  public async getPerformance(
    aDateRange: DateRange = 'max'
  ): Promise<PortfolioPerformance> {
    const dateRangeDate = this.convertDateRangeToDate(
      aDateRange,
      this.getMinDate()
    );

    const currentInvestment = this.getInvestment(new Date());
    const currentValue = await this.getValue();

    let originalInvestment = currentInvestment;
    let originalValue = this.getCommittedFunds();

    if (dateRangeDate) {
      originalInvestment = this.getInvestment(dateRangeDate);
      originalValue = (await this.getValue(dateRangeDate)) || originalValue;
    }

    const fees = this.getFees(dateRangeDate);

    const currentGrossPerformance =
      currentValue - currentInvestment - (originalValue - originalInvestment);

    // https://www.skillsyouneed.com/num/percent-change.html
    const currentGrossPerformancePercent =
      currentGrossPerformance / originalInvestment || 0;

    const currentNetPerformance = currentGrossPerformance - fees;

    // https://www.skillsyouneed.com/num/percent-change.html
    const currentNetPerformancePercent =
      currentNetPerformance / originalInvestment || 0;

    return {
      currentGrossPerformance,
      currentGrossPerformancePercent,
      currentNetPerformance,
      currentNetPerformancePercent,
      currentValue
    };
  }

  public getPositions(aDate: Date) {
    const [portfolioItem] = this.get(aDate);

    if (portfolioItem) {
      return portfolioItem.positions;
    }

    return {};
  }

  public getPortfolioItems() {
    return this.portfolioItems;
  }

  public async getReport(): Promise<PortfolioReport> {
    const details = await this.getDetails();

    if (isEmpty(details)) {
      return {
        rules: {}
      };
    }

    return {
      rules: {
        accountClusterRisk: await this.rulesService.evaluate(
          this,
          [
            new AccountClusterRiskInitialInvestment(
              this.exchangeRateDataService
            ),
            new AccountClusterRiskCurrentInvestment(
              this.exchangeRateDataService
            ),
            new AccountClusterRiskSingleAccount(this.exchangeRateDataService)
          ],
          { baseCurrency: this.user.Settings.currency }
        ),
        currencyClusterRisk: await this.rulesService.evaluate(
          this,
          [
            new CurrencyClusterRiskBaseCurrencyInitialInvestment(
              this.exchangeRateDataService
            ),
            new CurrencyClusterRiskBaseCurrencyCurrentInvestment(
              this.exchangeRateDataService
            ),
            new CurrencyClusterRiskInitialInvestment(
              this.exchangeRateDataService
            ),
            new CurrencyClusterRiskCurrentInvestment(
              this.exchangeRateDataService
            )
          ],
          { baseCurrency: this.user.Settings.currency }
        ),
        fees: await this.rulesService.evaluate(
          this,
          [new FeeRatioInitialInvestment(this.exchangeRateDataService)],
          { baseCurrency: this.user.Settings.currency }
        )
      }
    };
  }

  public getSymbols(aDate?: Date) {
    let symbols: string[] = [];

    if (aDate) {
      const positions = this.getPositions(aDate);

      for (const symbol in positions) {
        if (positions[symbol].quantity > 0) {
          symbols.push(symbol);
        }
      }
    } else {
      symbols = this.orders
        .filter((order) => order.getIsDraft() === false)
        .map((order) => {
          return order.getSymbol();
        });
    }

    // unique values
    return Array.from(new Set(symbols));
  }

  public getTotalBuy() {
    return this.orders
      .filter(
        (order) => order.getIsDraft() === false && order.getType() === 'BUY'
      )
      .map((order) => {
        return this.exchangeRateDataService.toCurrency(
          order.getTotal(),
          order.getCurrency(),
          this.user.Settings.currency
        );
      })
      .reduce((previous, current) => previous + current, 0);
  }

  public getTotalSell() {
    return this.orders
      .filter(
        (order) => order.getIsDraft() === false && order.getType() === 'SELL'
      )
      .map((order) => {
        return this.exchangeRateDataService.toCurrency(
          order.getTotal(),
          order.getCurrency(),
          this.user.Settings.currency
        );
      })
      .reduce((previous, current) => previous + current, 0);
  }

  public getOrders(aSymbol?: string) {
    if (aSymbol) {
      return this.orders.filter((order) => {
        return order.getSymbol() === aSymbol;
      });
    }

    return this.orders;
  }

  public getValue(aDate = getToday()) {
    const positions = this.getPositions(aDate);
    let value = 0;

    const [portfolioItem] = this.get(aDate);

    for (const symbol in positions) {
      if (portfolioItem.positions[symbol]?.quantity > 0) {
        if (
          isBefore(
            aDate,
            parseISO(portfolioItem.positions[symbol]?.firstBuyDate)
          ) ||
          portfolioItem.positions[symbol]?.marketPrice === 0
        ) {
          value += this.exchangeRateDataService.toCurrency(
            portfolioItem.positions[symbol]?.quantity *
              portfolioItem.positions[symbol]?.averagePrice,
            portfolioItem.positions[symbol]?.currency,
            this.user.Settings.currency
          );
        } else {
          value += this.exchangeRateDataService.toCurrency(
            portfolioItem.positions[symbol]?.quantity *
              portfolioItem.positions[symbol]?.marketPrice,
            portfolioItem.positions[symbol]?.currency,
            this.user.Settings.currency
          );
        }
      }
    }

    return isFinite(value) ? value : null;
  }

  public async setOrders(aOrders: OrderWithAccount[]) {
    this.orders = [];

    // Map data
    aOrders.forEach((order) => {
      this.orders.push(
        new Order({
          account: order.Account,
          currency: order.currency,
          date: order.date.toISOString(),
          fee: order.fee,
          quantity: order.quantity,
          symbol: order.symbol,
          symbolProfile: order.SymbolProfile,
          type: <OrderType>order.type,
          unitPrice: order.unitPrice
        })
      );
    });

    await this.update();

    return this;
  }

  public setUser(aUser: UserWithSettings) {
    this.user = aUser;

    return this;
  }

  private async getCashPosition({
    cashDetails,
    investment,
    value
  }: {
    cashDetails: CashDetails;
    investment: number;
    value: number;
  }) {
    const accounts = {};
    const cashValue = cashDetails.balance;

    cashDetails.accounts.forEach((account) => {
      accounts[account.name] = {
        current: account.balance,
        original: account.balance
      };
    });

    return {
      accounts,
      allocationCurrent: cashValue / value,
      allocationInvestment: cashValue / investment,
      countries: [],
      currency: Currency.CHF,
      grossPerformance: 0,
      grossPerformancePercent: 0,
      investment: cashValue,
      marketPrice: 0,
      marketState: MarketState.open,
      name: Type.Cash,
      quantity: 0,
      sectors: [],
      symbol: ghostfolioCashSymbol,
      type: Type.Cash,
      transactionCount: 0,
      value: cashValue
    };
  }

  /**
   * TODO: Refactor
   */
  private async update() {
    this.portfolioItems = [];

    let currentDate = this.getMinDate();

    if (!currentDate) {
      return;
    }

    // Set current date to first of month
    currentDate = setDate(currentDate, 1);

    const historicalData = await this.dataProviderService.getHistorical(
      this.getSymbols(),
      'month',
      currentDate,
      new Date()
    );

    while (isBefore(currentDate, Date.now())) {
      const positions: { [symbol: string]: Position } = {};
      this.getSymbols().forEach((symbol) => {
        positions[symbol] = {
          symbol,
          averagePrice: 0,
          currency: undefined,
          firstBuyDate: null,
          investment: 0,
          investmentInOriginalCurrency: 0,
          marketPrice:
            historicalData[symbol]?.[format(currentDate, DATE_FORMAT)]
              ?.marketPrice || 0,
          quantity: 0,
          transactionCount: 0
        };
      });

      if (!isYesterday(currentDate) && !isToday(currentDate)) {
        // Add to portfolio (ignore yesterday and today because they are added later)
        this.portfolioItems.push(
          cloneDeep({
            date: currentDate.toISOString(),
            grossPerformancePercent: 0,
            investment: 0,
            positions: positions,
            value: 0
          })
        );
      }

      const year = getYear(currentDate);
      const month = getMonth(currentDate);
      const day = getDate(currentDate);

      // Count month one up for iteration
      currentDate = new Date(Date.UTC(year, month + 1, day, 0));
    }

    const yesterday = getYesterday();

    const positions: { [symbol: string]: Position } = {};

    if (isAfter(yesterday, this.getMinDate())) {
      // Add yesterday
      this.getSymbols().forEach((symbol) => {
        positions[symbol] = {
          symbol,
          averagePrice: 0,
          currency: undefined,
          firstBuyDate: null,
          investment: 0,
          investmentInOriginalCurrency: 0,
          marketPrice:
            historicalData[symbol]?.[format(yesterday, DATE_FORMAT)]
              ?.marketPrice || 0,
          name: '',
          quantity: 0,
          transactionCount: 0
        };
      });

      this.portfolioItems.push(
        cloneDeep({
          positions,
          date: yesterday.toISOString(),
          grossPerformancePercent: 0,
          investment: 0,
          value: 0
        })
      );
    }

    this.updatePortfolioItems();
  }

  private convertDateRangeToDate(aDateRange: DateRange, aMinDate: Date) {
    let currentDate = new Date();

    const normalizedMinDate =
      getDate(aMinDate) === 1
        ? aMinDate
        : add(setDate(aMinDate, 1), { months: 1 });

    const year = getYear(currentDate);
    const month = getMonth(currentDate);
    const day = getDate(currentDate);

    currentDate = new Date(Date.UTC(year, month, day, 0));

    switch (aDateRange) {
      case '1d':
        return sub(currentDate, {
          days: 1
        });
      case 'ytd':
        currentDate = setDate(currentDate, 1);
        currentDate = setMonth(currentDate, 0);
        return isAfter(currentDate, normalizedMinDate)
          ? currentDate
          : undefined;
      case '1y':
        currentDate = setDate(currentDate, 1);
        currentDate = sub(currentDate, {
          years: 1
        });
        return isAfter(currentDate, normalizedMinDate)
          ? currentDate
          : undefined;
      case '5y':
        currentDate = setDate(currentDate, 1);
        currentDate = sub(currentDate, {
          years: 5
        });
        return isAfter(currentDate, normalizedMinDate)
          ? currentDate
          : undefined;
      default:
        // Gets handled as all data
        return undefined;
    }
  }

  private updatePortfolioItems() {
    let currentDate = new Date();

    const year = getYear(currentDate);
    const month = getMonth(currentDate);
    const day = getDate(currentDate);

    currentDate = new Date(Date.UTC(year, month, day, 0));

    if (this.portfolioItems?.length === 1) {
      // At least one portfolio items is needed, keep it but change the date to today.
      // This happens if there are only orders from today
      this.portfolioItems[0].date = currentDate.toISOString();
    } else {
      // Only keep entries which are not before first buy date
      this.portfolioItems = this.portfolioItems.filter((portfolioItem) => {
        return (
          isSameDay(parseISO(portfolioItem.date), this.getMinDate()) ||
          isAfter(parseISO(portfolioItem.date), this.getMinDate())
        );
      });
    }

    this.orders.forEach((order) => {
      if (order.getIsDraft() === false) {
        let index = this.portfolioItems.findIndex((item) => {
          const dateOfOrder = setDate(parseISO(order.getDate()), 1);
          return isSameDay(parseISO(item.date), dateOfOrder);
        });

        if (index === -1) {
          // if not found, we only have one order, which means we do not loop below
          index = 0;
        }

        for (let i = index; i < this.portfolioItems.length; i++) {
          // Set currency
          this.portfolioItems[i].positions[order.getSymbol()].currency =
            order.getCurrency();

          this.portfolioItems[i].positions[
            order.getSymbol()
          ].transactionCount += 1;

          if (order.getType() === 'BUY') {
            if (
              !this.portfolioItems[i].positions[order.getSymbol()].firstBuyDate
            ) {
              this.portfolioItems[i].positions[order.getSymbol()].firstBuyDate =
                resetHours(parseISO(order.getDate())).toISOString();
            }

            this.portfolioItems[i].positions[order.getSymbol()].quantity +=
              order.getQuantity();
            this.portfolioItems[i].positions[order.getSymbol()].investment +=
              this.exchangeRateDataService.toCurrency(
                order.getTotal(),
                order.getCurrency(),
                this.user.Settings.currency
              );
            this.portfolioItems[i].positions[
              order.getSymbol()
            ].investmentInOriginalCurrency += order.getTotal();

            this.portfolioItems[i].investment +=
              this.exchangeRateDataService.toCurrency(
                order.getTotal(),
                order.getCurrency(),
                this.user.Settings.currency
              );
          } else if (order.getType() === 'SELL') {
            this.portfolioItems[i].positions[order.getSymbol()].quantity -=
              order.getQuantity();

            if (
              this.portfolioItems[i].positions[order.getSymbol()].quantity === 0
            ) {
              this.portfolioItems[i].positions[
                order.getSymbol()
              ].investment = 0;
              this.portfolioItems[i].positions[
                order.getSymbol()
              ].investmentInOriginalCurrency = 0;
            } else {
              this.portfolioItems[i].positions[order.getSymbol()].investment -=
                this.exchangeRateDataService.toCurrency(
                  order.getTotal(),
                  order.getCurrency(),
                  this.user.Settings.currency
                );
              this.portfolioItems[i].positions[
                order.getSymbol()
              ].investmentInOriginalCurrency -= order.getTotal();
            }

            this.portfolioItems[i].investment -=
              this.exchangeRateDataService.toCurrency(
                order.getTotal(),
                order.getCurrency(),
                this.user.Settings.currency
              );
          }

          this.portfolioItems[i].positions[order.getSymbol()].averagePrice =
            this.portfolioItems[i].positions[order.getSymbol()]
              .investmentInOriginalCurrency /
            this.portfolioItems[i].positions[order.getSymbol()].quantity;

          const currentValue = this.getValue(
            parseISO(this.portfolioItems[i].date)
          );

          this.portfolioItems[i].grossPerformancePercent =
            currentValue / this.portfolioItems[i].investment - 1 || 0;
          this.portfolioItems[i].value = currentValue;
        }
      }
    });
  }
}
